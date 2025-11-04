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

// 分页期间：彻底暂停线程化（返回原生 posts），避免 anchorScroll 取不到锚点
let suspendThreading = false;
let rebuildPending = false;

// 快速滚动期间：同样暂停线程化与可见区排序（避免锚点抖动）
let isUserScrolling = false;
let scrollIdleTimer = null;

// 防抖：在滚动或分页结束后的短暂空闲期再重排
let rebuildTimer = null;
const REBUILD_DEBOUNCE_MS = 80;   // 经验值：既能消除闪烁又不显迟滞
const SCROLL_IDLE_MS     = 120;   // 认为用户停止滚动的阈值

// 轻量补充：补父 / 少量子（可开关）
const enableMinimalChildLoading = true;

export function initThreadedPostStream() {
  // —— 捕捉滚动，进入“滚动期暂停” —— //
  extend(PostStream.prototype, 'onscroll', function () {
    isUserScrolling = true;
    if (scrollIdleTimer) clearTimeout(scrollIdleTimer);
    scrollIdleTimer = setTimeout(() => {
      isUserScrolling = false;
      if (rebuildPending && !suspendThreading) {
        // 滚动刚刚停止，补一次重排
        rebuildPending = false;
        scheduleRebuild(this);
      }
    }, SCROLL_IDLE_MS);
  });

  // 在分页开始/结束时切换“暂停重排”标志，并在结束后补做一次重排
  override(PostStreamState.prototype, '_loadPrevious', function (original, ...args) {
    suspendThreading = true;
    const p = original(...args);
    return Promise.resolve(p).finally(() => {
      suspendThreading = false;
      // 分页刚结束，如果此前打了重排标记，就在空闲期补一次
      if (rebuildPending && !isUserScrolling) {
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
      if (rebuildPending && !isUserScrolling) {
        rebuildPending = false;
        const ps = this.discussion && this.discussion.postStream ? this.discussion.postStream : null;
        if (ps) scheduleRebuild(ps);
      }
    });
  });

  // ✅ 可见列表“轻排序”：只在【不分页 & 不滚动】时按预取顺序稳定排序，避免首屏闪一下
  extend(PostStreamState.prototype, 'visiblePosts', function (result) {
    if (suspendThreading || isUserScrolling) return;
    if (!Array.isArray(result) || result.length <= 1) return;

    const did =
      (this.discussion && typeof this.discussion.id === 'function' && this.discussion.id()) ||
      (this.discussion && this.discussion.id) ||
      null;

    result.sort((a, b) => {
      const aid = a && a.id ? a.id() : null;
      const bid = b && b.id ? b.id() : null;
      if (!aid || !bid) return 0;

      const ao = getOrderIndex(did, aid);
      const bo = getOrderIndex(did, bid);

      if (ao != null || bo != null) {
        if (ao == null) return 1;
        if (bo == null) return -1;
        if (ao !== bo) return ao - bo;
      }
      return 0;
    });
  });

  // 绑定 PostStream 生命周期
  extend(PostStream.prototype, 'oninit', function () {
    const did = this.stream && this.stream.discussion && this.stream.discussion.id();
    if (currentDiscussionId !== did) resetState(did);

    if (did) prefetchThreadOrder(did); // 首帧预取全局顺序（极轻）

    if (!originalPostsMethod) originalPostsMethod = this.stream.posts;

    // 覆盖 posts()：分页/滚动/重排中一律返回原生 posts；其它情况优先返回缓存
    this.stream.posts = () => {
      if (suspendThreading || isUserScrolling || isReordering) {
        // ⚠ 保证 anchorScroll 期间拿到的是稳定数组
        return (originalPostsMethod.call(this.stream) || []).map(x => x ?? null);
      }
      if (reorderedPostsCache) return reorderedPostsCache;

      const original = (originalPostsMethod.call(this.stream) || []).map(x => x ?? null);
      // 初载且有内容时拉起一次重排（异步＋防抖）
      if (original.filter(Boolean).length > 0) scheduleRebuild(this);
      return original;
    };

    // 记录当前帖子数
    const cur = (originalPostsMethod.call(this.stream) || []).map(x => x ?? null);
    lastPostCount = cur.filter(Boolean).length;

    // 首帧尽量重排（若不在分页/滚动中）
    if (lastPostCount > 0 && !suspendThreading && !isUserScrolling) scheduleRebuild(this);
  });

  extend(PostStream.prototype, 'oncreate', function () {
    clearThreadDepthCache();
  });

  // 帖子数变化：分页/滚动中仅做标记；结束后空闲期补排；非暂停立即重排
  extend(PostStream.prototype, 'onupdate', function () {
    if (!originalPostsMethod) return;
    const current = (originalPostsMethod.call(this.stream) || []).map(x => x ?? null);
    const count = current.filter(Boolean).length;

    if (count !== lastPostCount) {
      lastPostCount = count;
      reorderedPostsCache = null;
      clearThreadDepthCache();

      if (suspendThreading || isUserScrolling) {
        rebuildPending = true;
      } else {
        scheduleRebuild(this);
      }
    }
  });
}

// ========== 重排主流程 ========== //

function scheduleRebuild(postStream) {
  // 滚动/分页中不立刻重排，只做“待办标记”
  if (suspendThreading || isUserScrolling) {
    rebuildPending = true;
    return;
  }
  // 防抖：合并短时间内的多次请求
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => updateReorderedCache(postStream), REBUILD_DEBOUNCE_MS);
}

function updateReorderedCache(postStream) {
  if (isReordering) return;
  if (suspendThreading || isUserScrolling) {
    rebuildPending = true;
    return;
  }
  isReordering = true;

  try {
    if (!originalPostsMethod) return finish(null);

    const originalPosts = (originalPostsMethod.call(postStream.stream) || []).map(x => x ?? null);
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

        // —— 优先按 /threads-order 预取顺序排序 —— //
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
    reorderedPostsCache = arr; // 允许为 null：上层会回退原数组
    isReordering = false;
    // 下一帧重绘，确保 DOM/锚点稳定
    requestAnimationFrame(() => m.redraw());
  }
}

function padToOriginalLength(originalPosts, threadedPosts) {
  // 强保证：绝不返回 undefined，仅允许 Post 或 null
  const result = Array.isArray(threadedPosts) ? threadedPosts.slice() : [];
  for (let i = 0; i < result.length; i++) result[i] = result[i] ?? null;

  const need = Math.max(0, originalPosts.length - result.length);
  for (let i = 0; i < need; i++) result.push(null);
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
  isUserScrolling = false;
  if (rebuildTimer) { clearTimeout(rebuildTimer); rebuildTimer = null; }
  if (scrollIdleTimer) { clearTimeout(scrollIdleTimer); scrollIdleTimer = null; }
  clearThreadDepthCache();
}

// Debug（可选）
export function getThreadedPostsCache() { return reorderedPostsCache; }
export function forceRebuildCache(ps) {
  reorderedPostsCache = null;
  clearThreadDepthCache();
  scheduleRebuild(ps);
}
export function isThreadingActive() { return !!(reorderedPostsCache && originalPostsMethod); }
export function getThreadingStats() {
  return {
    hasCachedPosts: !!reorderedPostsCache,
    cachedPostCount: reorderedPostsCache ? reorderedPostsCache.filter(Boolean).length : 0,
    isReordering, lastPostCount,
    suspendThreading, rebuildPending, isUserScrolling,
    discussionId: currentDiscussionId,
    hasOriginalMethod: !!originalPostsMethod,
  };
}
