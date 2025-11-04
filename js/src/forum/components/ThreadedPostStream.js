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

// 分页中的保护：分页时不重排，结束后一次补做
let pagingDepth = 0;
let rebuildPending = false;

// 可选：为了让底层评论区更“连贯”，在重排前尽量把缺少的父/少量子补全
const enableMinimalChildLoading = true;

export function initThreadedPostStream() {
  // 标记分页开始/结束
  override(PostStreamState.prototype, '_loadPrevious', function (original, ...args) {
    pagingDepth++;
    const p = original(...args);
    return Promise.resolve(p).finally(() => {
      pagingDepth = Math.max(0, pagingDepth - 1);
      if (pagingDepth === 0 && rebuildPending) {
        rebuildPending = false;
        const ps = this.discussion && this.discussion.postStream ? this.discussion.postStream : null;
        if (ps) {
          // 讨论页中的 PostStream 实例
          scheduleRebuild(ps);
        } else {
          m.redraw();
        }
      }
    });
  });

  override(PostStreamState.prototype, '_loadNext', function (original, ...args) {
    pagingDepth++;
    const p = original(...args);
    return Promise.resolve(p).finally(() => {
      pagingDepth = Math.max(0, pagingDepth - 1);
      if (pagingDepth === 0 && rebuildPending) {
        rebuildPending = false;
        const ps = this.discussion && this.discussion.postStream ? this.discussion.postStream : null;
        if (ps) scheduleRebuild(ps); else m.redraw();
      }
    });
  });

  // 绑定 PostStream 生命周期
  extend(PostStream.prototype, 'oninit', function () {
    const did = this.stream && this.stream.discussion && this.stream.discussion.id();
    if (currentDiscussionId !== did) resetState(did);

    // 提前预取“全局线程顺序”（几乎无开销）
    if (did) prefetchThreadOrder(did);

    // 保存原 posts()，并覆盖
    if (!originalPostsMethod) originalPostsMethod = this.stream.posts;

    this.stream.posts = () => {
      if (reorderedPostsCache) return reorderedPostsCache;

      const original = originalPostsMethod.call(this.stream) || [];
      if (!isReordering && pagingDepth === 0 && original.filter(Boolean).length > 0) {
        // 初载或者缓存失效时触发一次重排
        scheduleRebuild(this);
      }
      return original;
    };

    // 记录当前计数
    const cur = originalPostsMethod.call(this.stream) || [];
    lastPostCount = cur.filter(Boolean).length;

    // 首帧尽量重排（若有数据且不在分页中）
    if (lastPostCount > 0 && pagingDepth === 0) scheduleRebuild(this);
  });

  // 讨论切换时清深度缓存
  extend(PostStream.prototype, 'oncreate', function () {
    clearThreadDepthCache();
  });

  // 帖子数变化时：分页中先挂起，结束后补做
  extend(PostStream.prototype, 'onupdate', function () {
    if (!originalPostsMethod) return;
    const current = originalPostsMethod.call(this.stream) || [];
    const count = current.filter(Boolean).length;
    if (count !== lastPostCount) {
      lastPostCount = count;
      reorderedPostsCache = null;
      clearThreadDepthCache();
      if (pagingDepth > 0) {
        rebuildPending = true;
      } else {
        scheduleRebuild(this);
      }
    }
  });
}

// ========== 重排主流程（可复用） ========== //

function scheduleRebuild(postStream) {
  // 避免同步阻塞渲染
  setTimeout(() => updateReorderedCache(postStream), 0);
}

function updateReorderedCache(postStream) {
  if (isReordering) return;
  if (pagingDepth > 0) {
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
        // —— 优先使用“预取顺序”排序 —— //
        const did = postStream.stream && postStream.stream.discussion && postStream.stream.discussion.id();
        const gotOrder = (p) => {
          const id = p && p.id ? p.id() : null;
          if (!id) return null;
          const idx = getOrderIndex(did, id);
          return typeof idx === 'number' ? idx : null;
        };

        let sorted;
        const haveAnyOrder = postsReady.some((p) => gotOrder(p) !== null);

        if (haveAnyOrder) {
          // 按全局 threads-order 排序；无记录的放在末尾且保持原相对顺序
          sorted = postsReady.slice().sort((a, b) => {
            const ao = gotOrder(a);
            const bo = gotOrder(b);
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
    reorderedPostsCache = arr; // 允许为 null：上层会回退到原数组
    isReordering = false;
    setTimeout(() => m.redraw(), 0);
  }
}

function padToOriginalLength(originalPosts, threadedPosts) {
  if (!Array.isArray(threadedPosts) || threadedPosts.length === 0) return originalPosts;
  const result = [...threadedPosts];
  const need = Math.max(0, originalPosts.length - threadedPosts.length);
  for (let i = 0; i < need; i++) result.push(null); // 只补 null，不出现 undefined
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

// —— 工具：讨论切换时复位 —— //
function resetState(discussionId) {
  currentDiscussionId = discussionId;
  isReordering = false;
  reorderedPostsCache = null;
  originalPostsMethod = null;
  lastPostCount = 0;
  pagingDepth = 0;
  rebuildPending = false;
  clearThreadDepthCache();
}

// —— Debug hooks（可选导出） —— //
export function getThreadedPostsCache() { return reorderedPostsCache; }
export function forceRebuildCache(ps) { reorderedPostsCache = null; clearThreadDepthCache(); scheduleRebuild(ps); }
export function isThreadingActive() { return !!(reorderedPostsCache && originalPostsMethod); }
export function getThreadingStats() {
  return {
    hasCachedPosts: !!reorderedPostsCache,
    cachedPostCount: reorderedPostsCache ? reorderedPostsCache.filter(Boolean).length : 0,
    isReordering, lastPostCount, pagingDepth, rebuildPending, discussionId: currentDiscussionId,
    hasOriginalMethod: !!originalPostsMethod,
  };
}
