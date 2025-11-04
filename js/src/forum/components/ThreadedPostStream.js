import app from 'flarum/forum/app';
import { extend, override } from 'flarum/common/extend';
import PostStream from 'flarum/forum/components/PostStream';
import PostStreamState from 'flarum/forum/states/PostStreamState';

import { createThreadedPosts } from '../utils/ThreadTree';
import { clearThreadDepthCache } from '../utils/ThreadDepth';
import { loadMissingParentPosts, loadMinimalChildren } from '../utils/PostLoader';
import { prefetchThreadOrder, getOrderIndex } from '../utils/ThreadOrderPrefetch';

// —— 全局状态 —— //
let isReordering = false;
let reorderedPostsCache = null;
let originalPostsMethod = null;
let lastPostCount = 0;
let currentDiscussionId = null;

// 分页期间暂停线程化（让 anchorScroll 拿到稳定锚点）
let suspendThreading = false;
let rebuildPending = false;

// 轻量补充：补父 / 少量子
const enableMinimalChildLoading = true;

export function initThreadedPostStream() {
  // 分页开始/结束：暂停 → 结束后如有标记再补一次重排
  override(PostStreamState.prototype, '_loadPrevious', function (original, ...args) {
    suspendThreading = true;
    const p = original(...args);
    return Promise.resolve(p).finally(() => {
      suspendThreading = false;
      if (rebuildPending) {
        rebuildPending = false;
        const ps = this.discussion && this.discussion.postStream ? this.discussion.postStream : null;
        if (ps) scheduleRebuild(ps);
      }
    });
  });

  override(PostStreamState.prototype, '_loadNext', function (original, ...args) {
    suspendThreading = true;
    const p = original(...args);
    return Promise.resolve(p).finally(() => {
      suspendThreading = false;
      if (rebuildPending) {
        rebuildPending = false;
        const ps = this.discussion && this.discussion.postStream ? this.discussion.postStream : null;
        if (ps) scheduleRebuild(ps);
      }
    });
  });

  // ✅ 新增：在“可见列表”阶段就按预取顺序做稳定排序，消除闪烁
  extend(PostStreamState.prototype, 'visiblePosts', function (result) {
    if (!Array.isArray(result) || result.length <= 1) return;

    // 当前讨论 id
    const did =
      (this.discussion && typeof this.discussion.id === 'function' && this.discussion.id()) ||
      (this.discussion && this.discussion.id) ||
      null;

    // 就地稳定排序：1) 预取顺序；2)（若无）已计算缓存顺序；3) 否则保持原样
    result.sort((a, b) => {
      const aid = a && a.id ? a.id() : null;
      const bid = b && b.id ? b.id() : null;
      if (!aid || !bid) return 0;

      // 1) 预取顺序：/threads-order
      const ao = getOrderIndex(did, aid);
      const bo = getOrderIndex(did, bid);
      if (ao != null || bo != null) {
        if (ao == null) return 1;
        if (bo == null) return -1;
        if (ao !== bo) return ao - bo;
      }

      // 2) 若上一步都没有，就尽量把已有帖子（非 null）排在前面（防御性）
      return 0;
    });
  });

  // 绑定 PostStream 生命周期
  extend(PostStream.prototype, 'oninit', function () {
    const did = this.stream && this.stream.discussion && this.stream.discussion.id();
    if (currentDiscussionId !== did) resetState(did);

    if (did) prefetchThreadOrder(did);      // 首帧预取（极小开销）

    if (!originalPostsMethod) originalPostsMethod = this.stream.posts;

    // 覆盖 posts()：分页中返回原生；平时优先返回缓存
    this.stream.posts = () => {
      if (suspendThreading) {
        return originalPostsMethod.call(this.stream) || [];
      }
      if (reorderedPostsCache) return reorderedPostsCache;

      const original = originalPostsMethod.call(this.stream) || [];
      if (!isReordering && original.filter(Boolean).length > 0) {
        scheduleRebuild(this);              // 异步，不阻断首帧
      }
      return original;
    };

    const cur = originalPostsMethod.call(this.stream) || [];
    lastPostCount = cur.filter(Boolean).length;

    if (lastPostCount > 0 && !suspendThreading) scheduleRebuild(this);
  });

  extend(PostStream.prototype, 'oncreate', function () {
    clearThreadDepthCache();
  });

  // 帖子数变化：分页中仅打标记；结束后补排；非分页立即重排
  extend(PostStream.prototype, 'onupdate', function () {
    if (!originalPostsMethod) return;
    const current = originalPostsMethod.call(this.stream) || [];
    const count = current.filter(Boolean).length;

    if (count !== lastPostCount) {
      lastPostCount = count;
      reorderedPostsCache = null;
      clearThreadDepthCache();

      if (suspendThreading) {
        rebuildPending = true;
      } else {
        scheduleRebuild(this);
      }
    }
  });
}

// ========== 重排主流程 ========== //

function scheduleRebuild(postStream) {
  setTimeout(() => updateReorderedCache(postStream), 0);
}

function updateReorderedCache(postStream) {
  if (isReordering) return;
  if (suspendThreading) {
    rebuildPending = true;
    return;
  }
  isReordering = true;

  try {
    if (!originalPostsMethod) return finish(null);

    const originalPosts = originalPostsMethod.call(postStream.stream) || [];
    const valid = originalPosts.filter(Boolean);
    if (valid.length === 0) return finish(null);

    ensureParentsLoaded(postStream, valid)
      .then((postsWithParents) =>
        enableMinimalChildLoading
          ? ensureMinimalChildren(postStream, postsWithParents)
          : postsWithParents
      )
      .then((postsReady) => {
        const did = postStream.stream && postStream.stream.discussion && postStream.stream.discussion.id();

        // 优先按 /threads-order 预取顺序排序
        const orderOf = (p) => {
          const id = p && p.id ? p.id() : null;
          if (!id) return null;
          const idx = getOrderIndex(did, id);
          return Number.isInteger(idx) ? idx : null;
        };

        let sorted;
        const hasAnyOrder = postsReady.some((p) => orderOf(p) !== null);

        if (hasAnyOrder) {
          sorted = postsReady.slice().sort((a, b) => {
            const ao = orderOf(a);
            const bo = orderOf(b);
            if (ao == null && bo == null) return 0;
            if (ao == null) return 1;
            if (bo == null) return -1;
            return ao - bo;
          });
        } else {
          // 退回本地“父后跟子”的轻量线程化
          sorted = createThreadedPosts(postsReady);
        }

        const threadedArray = padToOriginalLength(originalPosts, sorted);
        finish(threadedArray);
      })
      .catch((err) => {
        console.warn('[Threadify] reorder fallback due to error:', err);
        const fallback = createThreadedPosts(valid);
        const threadedArray = padToOriginalLength(originalPosts, fallback);
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

function padToOriginalLength(originalPosts, threadedPosts) {
  if (!Array.isArray(threadedPosts) || threadedPosts.length === 0) return originalPosts;
  const result = [...threadedPosts];
  const need = Math.max(0, originalPosts.length - threadedPosts.length);
  for (let i = 0; i < need; i++) result.push(null); // 只补 null
  return result;
}

// —— 按需补父/少量子（失败即原样返回） —— //
function ensureParentsLoaded(postStream, posts) {
  if (typeof loadMissingParentPosts === 'function') {
    const ctx = postStream.discussion ? postStream : { discussion: postStream.stream.discussion };
    return loadMissingParentPosts(ctx, posts).catch(() => Promise.resolve(posts));
  }
  return Promise.resolve(posts);
}
function ensureMinimalChildren(postStream, posts) {
  if (typeof loadMinimalChildren === 'function') {
    const ctx = postStream.discussion ? postStream : { discussion: postStream.stream.discussion };
    return loadMinimalChildren(ctx, posts).catch(() => Promise.resolve(posts));
  }
  return Promise.resolve(posts);
}

// —— 切讨论时复位 —— //
function resetState(discussionId) {
  currentDiscussionId = discussionId;
  isReordering = false;
  reorderedPostsCache = null;
  originalPostsMethod = null;
  lastPostCount = 0;
  suspendThreading = false;
  rebuildPending = false;
  clearThreadDepthCache();
}

// Debug（可选）
export function getThreadedPostsCache() { return reorderedPostsCache; }
export function forceRebuildCache(ps) { reorderedPostsCache = null; clearThreadDepthCache(); scheduleRebuild(ps); }
export function isThreadingActive() { return !!(reorderedPostsCache && originalPostsMethod); }
export function getThreadingStats() {
  return {
    hasCachedPosts: !!reorderedPostsCache,
    cachedPostCount: reorderedPostsCache ? reorderedPostsCache.filter(Boolean).length : 0,
    isReordering, lastPostCount, suspendThreading, rebuildPending, discussionId: currentDiscussionId,
    hasOriginalMethod: !!originalPostsMethod,
  };
}
