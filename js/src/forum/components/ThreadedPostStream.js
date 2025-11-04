/**
 * Threaded PostStream Component (stable, no first-frame reorder)
 *
 * - 不阻断首帧：首次渲染先走 Flarum 原顺序，随后在 UI 空闲时稳定重排
 * - 稳定排序：仅在可见列表且不处于加载中时，对“帖子项”做排序；gap/哨兵绝不移动
 * - 预取顺序优先：使用 /threads-order 的轻量顺序，避免进入后瞬间抖动
 * - 线程顺序兜底：构建本地线程顺序（父后子、同级按时间）
 * - 只在帖子数量变更时重建缓存，减少 redraw
 */

import app from 'flarum/forum/app';
import { extend } from 'flarum/common/extend';
import PostStream from 'flarum/forum/components/PostStream';
import PostStreamState from 'flarum/forum/states/PostStreamState';

import { createThreadedPosts } from '../utils/ThreadTree';
import { clearThreadDepthCache } from '../utils/ThreadDepth';
import { loadMissingParentPosts, loadMinimalChildren } from '../utils/PostLoader';
import { getOrderIndex, prefetchThreadOrder } from '../utils/ThreadOrderPrefetch';

// ----- 模块级状态 -----
let isReordering = false;
let reorderedPostsCache = null;     // 线程化后的 posts（含 null 填充）
let lastPostCount = 0;
let originalPostsMethod = null;     // 保存 PostStream 的原始 posts()
let currentDiscussionId = null;
let threadedOrder = null;           // Map<postId, order>
let enableMinimalChildLoading = true;

// ===================================================================
// 初始化：挂接 PostStream 生命周期 & PostStreamState.visiblePosts
// ===================================================================
export function initThreadedPostStream() {
  // 首次初始化 & 讨论切换
  extend(PostStream.prototype, 'oninit', function () {
    const did = this.stream.discussion && this.stream.discussion.id && this.stream.discussion.id();
    if (currentDiscussionId !== did) resetState(did);

    if (!originalPostsMethod) originalPostsMethod = this.stream.posts;

    // 预取讨论的线程顺序（payload 很小）
    if (did) prefetchThreadOrder(did);

    // 覆写 posts：若已有缓存则给缓存；否则先原数据，后台异步构建缓存
    this.stream.posts = () => {
      if (reorderedPostsCache) return reorderedPostsCache;

      const original = originalPostsMethod.call(this.stream) || [];
      if (!isReordering && original.filter(Boolean).length > 0) {
        updateReorderedCache(this /* first kick */);
      }
      return original;
    };

    // 记录首屏帖子数，并尝试异步构建缓存
    const cur = originalPostsMethod.call(this.stream) || [];
    lastPostCount = cur.filter(Boolean).length;
    if (lastPostCount > 0) updateReorderedCache(this);
  });

  // “可见列表”排序：只在不加载时、且两边都是 Post 时才比较
  extend(PostStreamState.prototype, 'visiblePosts', function (result) {
    if (!Array.isArray(result) || result.length <= 1) return result;

    // 正在加载上一页/下一页/附近锚点时，不做任何重排，避免 anchorScroll 取不到 DOM
    const loadingLike = Object.keys(this || {}).some((k) => /^loading/i.test(k) && !!this[k]);
    if (loadingLike) return result;

    const did = this.discussion && this.discussion.id && this.discussion.id();
    if (!did) return result;

    // 用浅拷贝排序，避免就地 sort 破坏 core 的引用假设
    const arr = result.slice();

    arr.sort((a, b) => {
      const isPostA = !!(a && typeof a.id === 'function');
      const isPostB = !!(b && typeof b.id === 'function');
      if (!isPostA || !isPostB) return 0; // gap/哨兵保持原位

      const aid = a.id();
      const bid = b.id();

      // 1) 预取顺序优先（进入即位）
      const ao = getOrderIndex(did, aid);
      const bo = getOrderIndex(did, bid);
      if (ao != null || bo != null) {
        if (ao == null && bo == null) return 0;
        if (ao == null) return 1;
        if (bo == null) return -1;
        if (ao !== bo) return ao - bo;
      }

      // 2) 线程缓存顺序（缓存构建完成后）
      const toA = threadedOrder && threadedOrder.get && threadedOrder.get(aid);
      const toB = threadedOrder && threadedOrder.get && threadedOrder.get(bid);
      if (toA != null || toB != null) {
        if (toA == null && toB == null) return 0;
        if (toA == null) return 1;
        if (toB == null) return -1;
        if (toA !== toB) return toA - toB;
      }

      // 3) 否则保持原顺序（稳定排序）
      return 0;
    });

    return arr;
  });

  // 帖子数量变化 -> 重建缓存
  extend(PostStream.prototype, 'onupdate', function () {
    if (!originalPostsMethod) return;
    const current = originalPostsMethod.call(this.stream) || [];
    const count = current.filter(Boolean).length;

    if (count !== lastPostCount) {
      lastPostCount = count;
      reorderedPostsCache = null;
      threadedOrder = null;
      clearThreadDepthCache();
      updateReorderedCache(this);
    }
  });
}

// ===================================================================
// 缓存构建：补齐父/少量子 -> 线程化 -> 建立顺序索引
// ===================================================================
function updateReorderedCache(postStream) {
  if (isReordering) return;
  isReordering = true;

  const finish = (arr) => {
    reorderedPostsCache = arr;
    isReordering = false;
    // 用微任务/0ms 触发一次刷新；visiblePosts 在“非加载期”才会排序
    setTimeout(() => { try { m.redraw(); } catch (e) {} }, 0);
  };

  try {
    if (!originalPostsMethod) return finish(null);

    const originalPosts = originalPostsMethod.call(postStream.stream) || [];
    const validPosts = originalPosts.filter(Boolean);
    if (validPosts.length === 0) return finish(null);

    ensureParentsLoaded(postStream, validPosts)
      .then((postsWithParents) =>
        enableMinimalChildLoading
          ? ensureMinimalChildren(postStream, postsWithParents)
          : postsWithParents
      )
      .then((postsReady) => {
        const threaded = createThreadedPosts(postsReady);
        const threadedArray = createThreadedPostsArray(originalPosts, threaded);

        // 建立顺序索引
        threadedOrder = new Map();
        let idx = 0;
        threadedArray.forEach((p) => {
          if (p && typeof p.id === 'function') threadedOrder.set(p.id(), idx++);
        });

        finish(threadedArray);
      })
      .catch((err) => {
        console.warn('[Threadify] load parent/child failed, fallback threading:', err);
        const threaded = createThreadedPosts(validPosts);
        const threadedArray = createThreadedPostsArray(originalPosts, threaded);

        threadedOrder = new Map();
        let idx = 0;
        threadedArray.forEach((p) => {
          if (p && typeof p.id === 'function') threadedOrder.set(p.id(), idx++);
        });

        finish(threadedArray);
      });
  } catch (e) {
    console.error('[Threadify] Cache update failed:', e);
    finish(null);
  }
}

// 维持原数组长度（分页位）——不足用 null 填充
function createThreadedPostsArray(originalPosts, threadedPosts) {
  if (!Array.isArray(threadedPosts) || threadedPosts.length === 0) return originalPosts;
  const result = [...threadedPosts];
  const nullsNeeded = Math.max(0, originalPosts.length - threadedPosts.length);
  for (let i = 0; i < nullsNeeded; i++) result.push(null);
  return result;
}

// 父帖补齐：优先使用 utils；失败时回退按 id 精确拉取
function ensureParentsLoaded(postStream, posts) {
  if (typeof loadMissingParentPosts === 'function') {
    const ctx = postStream.discussion ? postStream : { discussion: postStream.stream.discussion };
    return loadMissingParentPosts(ctx, posts).catch(() => fallbackLoadParents(posts));
  }
  return fallbackLoadParents(posts);
}

// 少量子帖补齐（很保守，减少“二次抖动”）
function ensureMinimalChildren(postStream, posts) {
  if (typeof loadMinimalChildren === 'function') {
    const ctx = postStream.discussion ? postStream : { discussion: postStream.stream.discussion };
    return loadMinimalChildren(ctx, posts).catch(() => posts);
  }
  return Promise.resolve(posts);
}

// 回退父帖加载（按缺失的 parent_id 精确拉取）
function fallbackLoadParents(currentPosts) {
  const byId = new Map(currentPosts.filter(Boolean).map((p) => [String(p.id()), p]));
  const missing = [];
  currentPosts.forEach((p) => {
    const pid = p && p.attribute ? p.attribute('parent_id') : null;
    if (pid && !byId.has(String(pid))) missing.push(String(pid));
  });
  if (missing.length === 0) return Promise.resolve(currentPosts);

  return app.store
    .find('posts', { filter: { id: missing.join(',') } })
    .then((loaded) => fallbackLoadParents([...currentPosts, ...loaded]))
    .catch(() => currentPosts);
}

// ===================================================================
// 导出工具 & 重置状态
// ===================================================================
export function getThreadedPostsCache() { return reorderedPostsCache; }

export function forceRebuildCache(postStream) {
  reorderedPostsCache = null;
  threadedOrder = null;
  clearThreadDepthCache();
  updateReorderedCache(postStream);
}

export function isThreadingActive() { return !!(reorderedPostsCache && originalPostsMethod); }

export function getThreadingStats() {
  return {
    hasCachedPosts: !!reorderedPostsCache,
    cachedPostCount: reorderedPostsCache ? reorderedPostsCache.filter(Boolean).length : 0,
    isReordering,
    lastPostCount,
    hasOriginalMethod: !!originalPostsMethod,
    discussionId: currentDiscussionId,
  };
}

function resetState(discussionId) {
  currentDiscussionId = discussionId;
  isReordering = false;
  reorderedPostsCache = null;
  lastPostCount = 0;
  originalPostsMethod = null;
  threadedOrder = null;
  clearThreadDepthCache();
}
