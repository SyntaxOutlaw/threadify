import app from 'flarum/forum/app';
import { extend } from 'flarum/common/extend';
import PostStream from 'flarum/forum/components/PostStream';
import PostStreamState from 'flarum/forum/states/PostStreamState';

import { createThreadedPosts } from '../utils/ThreadTree';
import { clearThreadDepthCache } from '../utils/ThreadDepth';
import { loadMissingParentPosts, loadMinimalChildren } from '../utils/PostLoader';
import { getOrderIndex, prefetchThreadOrder } from '../utils/ThreadOrderPrefetch';

// 状态
let isReordering = false;
let reorderedPostsCache = null;
let lastPostCount = 0;
let originalPostsMethod = null;
let currentDiscussionId = null;
let threadedOrder = null;
let enableMinimalChildLoading = true;

export function initThreadedPostStream() {
  extend(PostStream.prototype, 'oninit', function () {
    const did = this.stream.discussion.id();
    if (currentDiscussionId !== did) resetState(did);
    if (!originalPostsMethod) originalPostsMethod = this.stream.posts;

    // 保险：确保触发一次预取（若 index.js 未命中）
    prefetchThreadOrder(did);

    this.stream.posts = () => {
      if (reorderedPostsCache) return reorderedPostsCache;
      const original = originalPostsMethod.call(this.stream);
      if (!isReordering && original && original.filter(Boolean).length > 0) {
        updateReorderedCache(this);
      }
      return original;
    };

    const cur = originalPostsMethod.call(this.stream) || [];
    lastPostCount = cur.filter(Boolean).length;
    if (lastPostCount > 0) updateReorderedCache(this);
  });

  // 可见列表排序兜底：优先“预取顺序”，再用线程化顺序
  extend(PostStreamState.prototype, 'visiblePosts', function (result) {
    if (!Array.isArray(result) || result.length <= 1) return;

    const did = this.discussion && this.discussion.id && this.discussion.id();
    result.sort((a, b) => {
      const aid = a && a.id ? a.id() : undefined;
      const bid = b && b.id ? b.id() : undefined;
      if (!aid || !bid) return 0;

      // 1) 预取顺序（首帧即位）
      const ao = getOrderIndex(did, aid);
      const bo = getOrderIndex(did, bid);
      if (ao != null || bo != null) {
        if (ao == null) return 1;
        if (bo == null) return -1;
        if (ao !== bo) return ao - bo;
      }

      // 2) 线程化顺序（缓存重建后）
      const toA = threadedOrder && threadedOrder.get(aid);
      const toB = threadedOrder && threadedOrder.get(bid);
      if (toA != null || toB != null) {
        if (toA == null) return 1;
        if (toB == null) return -1;
        if (toA !== toB) return toA - toB;
      }

      return 0;
    });
  });

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

function updateReorderedCache(postStream) {
  if (isReordering) return;
  isReordering = true;
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

        threadedOrder = new Map();
        let idx = 0;
        threadedArray.forEach((p) => { if (p && p.id) threadedOrder.set(p.id(), idx++); });

        finish(threadedArray);
      })
      .catch((err) => {
        console.warn('[Threadify] load parent/child failed, fallback threading:', err);
        const threaded = createThreadedPosts(validPosts);
        const threadedArray = createThreadedPostsArray(originalPosts, threaded);
        threadedOrder = new Map();
        let idx = 0;
        threadedArray.forEach((p) => { if (p && p.id) threadedOrder.set(p.id(), idx++); });
        finish(threadedArray);
      });

  } catch (e) {
    console.error('[Threadify] Cache update failed:', e);
    finish(null);
  }

  function finish(arr) {
    reorderedPostsCache = arr;
    isReordering = false;
    setTimeout(() => m.redraw(), 0);
  }
}

function createThreadedPostsArray(originalPosts, threadedPosts) {
  if (!Array.isArray(threadedPosts) || threadedPosts.length === 0) return originalPosts;
  const result = [...threadedPosts];
  const nullsNeeded = Math.max(0, originalPosts.length - threadedPosts.length);
  for (let i = 0; i < nullsNeeded; i++) result.push(null);
  return result;
}

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

// 导出（保持兼容）
export function getThreadedPostsCache() { return reorderedPostsCache; }
export function forceRebuildCache(postStream) {
  reorderedPostsCache = null; threadedOrder = null; clearThreadDepthCache(); updateReorderedCache(postStream);
}
export function isThreadingActive() { return !!(reorderedPostsCache && originalPostsMethod); }
export function getThreadingStats() {
  return {
    hasCachedPosts: !!reorderedPostsCache,
    cachedPostCount: reorderedPostsCache ? reorderedPostsCache.filter(Boolean).length : 0,
    isReordering, lastPostCount, hasOriginalMethod: !!originalPostsMethod, discussionId: currentDiscussionId,
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
