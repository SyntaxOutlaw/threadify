/**
 * Post Loader Utilities (fixed for Flarum 1.8)
 *
 * 修复点：
 * 1) 统一使用字符串比较 ID，避免 number/string 混用造成的漏判。
 * 2) 兼容 postStream.discussion 与 postStream.stream.discussion。
 * 3) 提供 mergeUniquePostsById 以防重复注入同一帖子。
 */

import app from 'flarum/forum/app';

/** -------------------- Helpers -------------------- **/

function toStrId(x) {
  return x == null ? '' : String(x);
}

function getDiscussionFrom(postStream) {
  // 兼容两种拿法
  return postStream?.discussion || postStream?.stream?.discussion || null;
}

function mergeUniquePostsById(basePosts, extraPosts) {
  const map = new Map();
  basePosts.filter(Boolean).forEach((p) => map.set(toStrId(p.id()), p));
  extraPosts.filter(Boolean).forEach((p) => map.set(toStrId(p.id()), p));
  return Array.from(map.values());
}

function loadPostsByIds(postIds) {
  const ids = (postIds || []).map(toStrId).filter(Boolean);
  if (ids.length === 0) return Promise.resolve([]);

  return app.store.find('posts', {
    filter: { id: ids.join(',') },
    // page: { limit: ids.length } // 可选：限制体积
  });
}

/** -------------------- Public APIs -------------------- **/

/**
 * 递归补齐“缺失父帖”
 * - 扫描 currentPosts，找出其 parent_id 未在集合中的父帖，批量拉取；
 * - 合并后若仍有更上层父帖缺失，则继续递归，直到根或已齐全。
 */
export function loadMissingParentPosts(postStream, currentPosts) {
  const posts = (currentPosts || []).filter(Boolean);
  const currentIdSet = new Set(posts.map((p) => toStrId(p.id())));
  const missingParentIds = [];

  posts.forEach((p) => {
    const pid = toStrId(p?.attribute?.('parent_id'));
    if (pid && !currentIdSet.has(pid)) missingParentIds.push(pid);
  });

  const uniqueMissing = Array.from(new Set(missingParentIds));
  if (uniqueMissing.length === 0) {
    return Promise.resolve(posts);
  }

  return loadPostsByIds(uniqueMissing)
    .then((loadedParents) => {
      const merged = mergeUniquePostsById(posts, loadedParents);
      // 递归，直到没有缺父帖
      return loadMissingParentPosts(postStream, merged);
    })
    .catch((err) => {
      console.warn('[Threadify] Failed to load parent posts:', err);
      // 出错时保守返回已有帖子，避免卡住
      return posts;
    });
}

/**
 * 仅“保守”补少量子帖
 * - 按讨论里尚未加载的 postId 取一个小样本（默认 5~10）；
 * - 只把其 parent_id 指向“当前已加载集合”的帖子作为“实际子帖”纳入；
 * - 不递归，避免二次抖动。
 */
export function loadMinimalChildren(postStream, currentPosts) {
  const discussion = getDiscussionFrom(postStream);
  const posts = (currentPosts || []).filter(Boolean);
  const currentIdSet = new Set(posts.map((p) => toStrId(p.id())));

  if (!discussion || typeof discussion.postIds !== 'function') {
    return Promise.resolve(posts);
  }

  const discussionPostIds = (discussion.postIds() || []).map(toStrId);
  const unloadedIds = discussionPostIds.filter((id) => id && !currentIdSet.has(id));

  if (unloadedIds.length === 0) {
    return Promise.resolve(posts);
  }

  const sampleSize = Math.min(10, unloadedIds.length); // 轻量探测
  const recentUnloaded = unloadedIds.slice(-sampleSize);

  return loadPostsByIds(recentUnloaded)
    .then((loadedSample) => {
      // 只收“父在集合里”的实际子帖
      const actualChildren = (loadedSample || []).filter((p) => {
        const pid = toStrId(p?.attribute?.('parent_id'));
        return pid && currentIdSet.has(pid);
      });

      if (actualChildren.length === 0) {
        return posts;
      }
      return mergeUniquePostsById(posts, actualChildren);
    })
    .catch((err) => {
      console.warn('[Threadify] Failed to load child posts:', err);
      return posts;
    });
}

/**
 * 检测是否“有理由补上下文”
 * - 目前仅检测是否存在缺失父帖；如需可扩展。
 */
export function needsThreadContext(posts) {
  const arr = (posts || []).filter(Boolean);
  if (arr.length === 0) return false;

  const idSet = new Set(arr.map((p) => toStrId(p.id())));
  return arr.some((p) => {
    const pid = toStrId(p?.attribute?.('parent_id'));
    return pid && !idSet.has(pid);
  });
}
