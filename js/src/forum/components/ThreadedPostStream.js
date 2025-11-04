// js/src/forum/components/ThreadedPostStream.js
import app from 'flarum/forum/app';
import { extend, override } from 'flarum/common/extend';
import PostStream from 'flarum/forum/components/PostStream';
import PostStreamState from 'flarum/forum/states/PostStreamState';

import { createThreadedPosts } from '../utils/ThreadTree';
import { clearThreadDepthCache } from '../utils/ThreadDepth';
import { loadMissingParentPosts, loadMinimalChildren } from '../utils/PostLoader';
import { getOrderIndex, prefetchThreadOrder } from '../utils/ThreadOrderPrefetch';

// ---------- 全局状态 ----------
let isReordering = false;
let reorderedPostsCache = null;
let lastPostCount = 0;
let originalPostsMethod = null;
let currentDiscussionId = null;
let threadedOrder = null;                 // Map<postId, order>
let enableMinimalChildLoading = true;

// 竞态/滚动防抖
let suspendCount = 0;                     // 并发加载挂起计数
let scrolling = false;
let scrollCooldownTimer = null;
const SCROLL_COOLDOWN_MS = 120;

let rebuildTimer = null;
let rafRedrawScheduled = false;

function isSuspended() {
  return suspendCount > 0 || scrolling;
}
function beginSuspend() { suspendCount++; }
function endSuspend()   { suspendCount = Math.max(0, suspendCount - 1); }

// 可传入 PostStream；缺省则只清缓存并触发重绘，让 posts() 在下一帧重建
function scheduleRebuild(psMaybe) {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    if (isSuspended()) {
      scheduleRebuild(psMaybe);
      return;
    }
    if (psMaybe) {
      // 直接强制重建
      forceRebuildCache(psMaybe);
    } else {
      // 清缓存，下一次 posts() 自动重建
      reorderedPostsCache = null;
      threadedOrder = null;
      clearThreadDepthCache();
    }
    if (!rafRedrawScheduled) {
      rafRedrawScheduled = true;
      (window.requestAnimationFrame || setTimeout)(() => {
        rafRedrawScheduled = false;
        try { m.redraw(); } catch (e) {}
      }, 16);
    }
  }, 120);
}

export function initThreadedPostStream() {
  extend(PostStream.prototype, 'oninit', function () {
    const did = this.stream.discussion.id();
    if (currentDiscussionId !== did) resetState(did);
    if (!originalPostsMethod) originalPostsMethod = this.stream.posts;

    // 预取顺序（极轻）
    prefetchThreadOrder(did);

    // 接管 posts()
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

  // 滚动冷却：滚动中不做重排，避免锚点计算被打断
  extend(PostStream.prototype, 'onscroll', function () {
    scrolling = true;
    clearTimeout(scrollCooldownTimer);
    scrollCooldownTimer = setTimeout(() => { scrolling = false; }, SCROLL_COOLDOWN_MS);
  });

  // 翻页：并发挂起，完成后再调度重建
  override(PostStreamState.prototype, '_loadPrevious', function (original, ...args) {
    beginSuspend();
    const p = original(...args);
    return Promise.resolve(p).finally(() => {
      endSuspend();
      const ps = this.discussion && this.discussion.postStream;
      scheduleRebuild(ps); // 没有 ps 也没关系，内部会触发下一帧重建
    });
  });

  override(PostStreamState.prototype, '_loadNext', function (original, ...args) {
    beginSuspend();
    const p = original(...args);
    return Promise.resolve(p).finally(() => {
      endSuspend();
      const ps = this.discussion && this.discussion.postStream;
      scheduleRebuild(ps);
    });
  });

  // 可见区稳定排序：优先 threads-order；其次已构建的 threadedOrder；无信息则保持原相对次序
  extend(PostStreamState.prototype, 'visiblePosts', function (result) {
    if (isSuspended()) return;
    if (!Array.isArray(result) || result.length <= 1) return;

    const did =
      (this.discussion && typeof this.discussion.id === 'function' && this.discussion.id()) ||
      (this.discussion && this.discussion.id) || null;

    const indexOf = new Map();
    result.forEach((p, i) => { if (p && typeof p.id === 'function') indexOf.set(p.id(), i); });

    result.sort((a, b) => {
      const aid = a && typeof a.id === 'function' ? a.id() : null;
      const bid = b && typeof b.id === 'function' ? b.id() : null;

      // 无效项（null/无 id）始终靠后，防止 render 读 null.tag
      if (aid == null && bid == null) return 0;
      if (aid == null) return 1;
      if (bid == null) return -1;

      // 1) 预取顺序
      const ao = getOrderIndex(did, aid);
      const bo = getOrderIndex(did, bid);
      if (ao != null || bo != null) {
        if (ao == null) return 1;
        if (bo == null) return -1;
        if (ao !== bo) return ao - bo;
      }

      // 2) 已构建线程顺序
      const toA = threadedOrder && threadedOrder.get(aid);
      const toB = threadedOrder && threadedOrder.get(bid);
      if (toA != null || toB != null) {
        if (toA == null) return 1;
        if (toB == null) return -1;
        if (toA !== toB) return toA - toB;
      }

      // 3) 稳定回退：保持原相对次序
      return (indexOf.get(aid) ?? 0) - (indexOf.get(bid) ?? 0);
    });
  });

  // 数据变化 -> 调度重建（不立即打断滚动/锚点）
  extend(PostStream.prototype, 'onupdate', function () {
    if (!originalPostsMethod) return;
    const current = originalPostsMethod.call(this.stream) || [];
    const count = current.filter(Boolean).length;
    if (count !== lastPostCount) {
      lastPostCount = count;
      reorderedPostsCache = null;
      threadedOrder = null;
      clearThreadDepthCache();
      scheduleRebuild(this);
    }
  });
}

// ---------- 重建缓存 ----------
function updateReorderedCache(postStream) {
  if (isReordering) return;
  isReordering = true;
  beginSuspend();

  const finish = (arr) => {
    reorderedPostsCache = arr;
    isReordering = false;
    endSuspend();
    (window.requestAnimationFrame || setTimeout)(() => { try { m.redraw(); } catch (e) {} }, 16);
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

// ---------- 导出 ----------
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

