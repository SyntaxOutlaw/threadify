/**
 * Threaded PostStream Component (stable / prefetch-order only)
 *
 * 设计要点：
 * - 首帧不阻断：首次渲染仍走 Flarum 原序；
 * - 预取顺序：在后台请求 /threads-order 后，用该“全局线程顺序”稳定重排；
 * - 不再篡改 visiblePosts（避免 anchorScroll 在翻页中读不到锚点导致报错）；
 * - 仅当帖子数变化且 PostStreamState 不处于任何 loading 阶段时才重排；
 * - 若预取失败则回退到简易线程化（ThreadTree），但仍不改 visiblePosts。
 */

import app from 'flarum/forum/app';
import { extend } from 'flarum/common/extend';
import PostStream from 'flarum/forum/components/PostStream';

import { createThreadedPosts } from '../utils/ThreadTree';
import { clearThreadDepthCache } from '../utils/ThreadDepth';
import { loadMissingParentPosts, loadMinimalChildren } from '../utils/PostLoader';
import { getOrderIndex, prefetchThreadOrder } from '../utils/ThreadOrderPrefetch';

// ---- 模块级状态 ----------------------------------------------------
let isReordering = false;
let reorderedPostsCache = null;   // 线程化后的 posts（含 null 填充以保持分页长度）
let lastPostCount = 0;
let originalPostsMethod = null;
let currentDiscussionId = null;
let enableMinimalChildLoading = false; // 仅在预取缺失时回退加载少量子帖

// ---- 工具：判定流是否忙碌（翻页/锚点附近加载等） --------------------
function streamBusy(state) {
  if (!state) return false;
  // 这些字段在 1.8 上都存在其一；逐项兜底判断
  return !!(
    state.loading ||
    state.loadingPrevious ||
    state.loadingNext ||
    state.loadingNear ||
    state._loadingPrevious || // 某些版本的内部标记
    state._loadingNext
  );
}

// ===================================================================
// 初始化：挂接 PostStream 生命周期
// ===================================================================
export function initThreadedPostStream() {
  extend(PostStream.prototype, 'oninit', function () {
    const did = this.stream.discussion && this.stream.discussion.id && this.stream.discussion.id();
    if (currentDiscussionId !== did) resetState(did);

    if (!originalPostsMethod) originalPostsMethod = this.stream.posts;

    // 预取轻量顺序（payload 很小）
    if (did) prefetchThreadOrder(did);

    // 覆写 posts：若已有缓存则返回缓存；否则回退原始 posts
    this.stream.posts = () => {
      if (reorderedPostsCache) return reorderedPostsCache;

      const original = originalPostsMethod.call(this.stream) || [];
      // 首帧不阻断：异步尝试重建缓存（使用预取顺序）
      if (!isReordering && original.filter(Boolean).length > 0) {
        buildCacheWithPrefetch(this);
      }
      return original;
    };

    // 记录首屏数量并尝试异步构建缓存
    const cur = originalPostsMethod.call(this.stream) || [];
    lastPostCount = cur.filter(Boolean).length;
    if (lastPostCount > 0) buildCacheWithPrefetch(this);
  });

  // 仅在帖子数变化时重建缓存；忙碌时跳过，稍后再试
  extend(PostStream.prototype, 'onupdate', function () {
    if (!originalPostsMethod) return;

    const current = originalPostsMethod.call(this.stream) || [];
    const count = current.filter(Boolean).length;

    if (count !== lastPostCount) {
      lastPostCount = count;
      reorderedPostsCache = null;
      clearThreadDepthCache();

      if (!streamBusy(this.stream)) {
        buildCacheWithPrefetch(this);
      } else {
        // 等到空闲再构建，避免 anchorScroll 报错
        setTimeout(() => {
          if (!streamBusy(this.stream)) buildCacheWithPrefetch(this);
        }, 60);
      }
    }
  });
}

// ===================================================================
// 核心：使用“预取顺序”构建缓存，失败时回退到简易线程化
// ===================================================================
function buildCacheWithPrefetch(postStream) {
  if (isReordering) return;
  isReordering = true;

  const finish = (arr) => {
    reorderedPostsCache = arr;
    isReordering = false;
    // 用 0ms 定时触发；避免与 core 的锚点计算同一帧冲突
    setTimeout(() => { try { m.redraw(); } catch (e) {} }, 0);
  };

  try {
    if (!originalPostsMethod) return finish(null);

    const originalPosts = originalPostsMethod.call(postStream.stream) || [];
    const validPosts = originalPosts.filter(Boolean);
    if (validPosts.length === 0) return finish(null);

    const did = postStream.stream.discussion && postStream.stream.discussion.id && postStream.stream.discussion.id();

    // 尝试根据“预取顺序”排序；若该顺序缺失，则回退到本地线程化
    sortByPrefetchOrder(did, validPosts).then((prefetchSorted) => {
      if (prefetchSorted && prefetchSorted.length) {
        const threadedArray = padNullsToLength(prefetchSorted, originalPosts.length);
        finish(threadedArray);
        return;
      }

      // —— 预取不可用：回退到“父帖补齐 + 少量子 + 简易线程化” ——
      ensureParentsLoaded(postStream, validPosts)
        .then((postsWithParents) =>
          enableMinimalChildLoading
            ? ensureMinimalChildren(postStream, postsWithParents)
            : postsWithParents
        )
        .then((postsReady) => {
          const threaded = createThreadedPosts(postsReady);
          const threadedArray = padNullsToLength(threaded, originalPosts.length);
          finish(threadedArray);
        })
        .catch((err) => {
          console.warn('[Threadify] prefetch & fallback threading both failed:', err);
          finish(null);
        });
    });
  } catch (e) {
    console.error('[Threadify] buildCacheWithPrefetch failed:', e);
    isReordering = false;
  }
}

// 用预取顺序排序（仅重排“已加载的帖子”数组，不触碰 gap/哨兵）
function sortByPrefetchOrder(discussionId, posts) {
  return Promise.resolve().then(() => {
    if (!discussionId || !Array.isArray(posts) || posts.length === 0) return null;

    // 判定是否至少有一条映射命中；若完全缺失就返回 null 走回退
    const hit = posts.some((p) => getOrderIndex(discussionId, p.id && p.id()));
    if (!hit) return null;

    const list = posts.slice();
    list.sort((a, b) => {
      const aid = a && a.id && a.id();
      const bid = b && b.id && b.id();
      const ao = getOrderIndex(discussionId, aid);
      const bo = getOrderIndex(discussionId, bid);

      if (ao != null || bo != null) {
        if (ao == null && bo == null) return 0;
        if (ao == null) return 1;
        if (bo == null) return -1;
        if (ao !== bo) return ao - bo;
      }

      // 两者都没有映射：保持相对顺序
      return 0;
    });

    return list;
  });
}

// 维持原数组长度（分页位）——不足用 null 填充
function padNullsToLength(arr, targetLen) {
  const result = Array.isArray(arr) ? arr.slice() : [];
  const need = Math.max(0, targetLen - result.length);
  for (let i = 0; i < need; i++) result.push(null);
  return result;
}

// ---- 父/子回退加载 -------------------------------------------------
function ensureParentsLoaded(postStream, posts) {
  if (typeof loadMissingParentPosts === 'function') {
    const ctx = postStream.discussion ? postStream : { discussion: postStream.stream.discussion };
    return loadMissingParentPosts(ctx, posts).catch(() => fallbackLoadParents(posts));
  }
  return fallbackLoadParents(posts);
}

function ensureMinimalChildren(postStream, posts) {
  if (typeof loadMinimalChildren === 'function') {
    const ctx = postStream.discussion ? postStream : { discussion: postStream.stream.discussion };
    return loadMinimalChildren(ctx, posts).catch(() => posts);
  }
  return Promise.resolve(posts);
}

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

// ---- 导出工具 ------------------------------------------------------
export function getThreadedPostsCache() { return reorderedPostsCache; }

export function forceRebuildCache(postStream) {
  reorderedPostsCache = null;
  clearThreadDepthCache();
  if (!streamBusy(postStream && postStream.stream)) buildCacheWithPrefetch(postStream);
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
  clearThreadDepthCache();
}

