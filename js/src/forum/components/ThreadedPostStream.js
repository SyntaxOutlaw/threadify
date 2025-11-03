/**
 * Threaded PostStream Component Extensions (FIXED + FIRST-FRAME GATING)
 *
 * 变更点：
 * 1) 首帧阻断：若检测到首屏存在“缺失父帖”，先补父帖+建树，再渲染首帧；避免先渲染原始顺序导致的跳动。
 * 2) 双保险接管顺序：覆写 this.stream.posts() + 在 PostStreamState.visiblePosts 稳定排序。
 */

import app from 'flarum/forum/app';
import { extend } from 'flarum/common/extend';
import PostStream from 'flarum/forum/components/PostStream';
import PostStreamState from 'flarum/forum/states/PostStreamState';
import LoadingIndicator from 'flarum/common/components/LoadingIndicator';

import { createThreadedPosts } from '../utils/ThreadTree';
import { clearThreadDepthCache } from '../utils/ThreadDepth';
import { loadMissingParentPosts, loadMinimalChildren } from '../utils/PostLoader';

// -------- 全局状态 --------
let isReordering = false;
let reorderedPostsCache = null;
let lastPostCount = 0;
let originalPostsMethod = null;
let currentDiscussionId = null;
let threadedOrder = null;
let enableMinimalChildLoading = true;

// 首帧阻断相关
let firstFrameGated = false;       // 是否需要阻断首帧
let firstBuildDone = false;        // 首次建树是否完成

export function initThreadedPostStream() {
  // 组件层：初始化
  extend(PostStream.prototype, 'oninit', function () {
    const did = this.stream.discussion.id();
    if (currentDiscussionId !== did) {
      resetState(did);
    }

    if (!originalPostsMethod) originalPostsMethod = this.stream.posts;

    // 判定首帧是否需要阻断：首屏可见数组中，只要有任何一个 post 的 parent 不在数组里，就阻断
    const initial = originalPostsMethod.call(this.stream) || [];
    const vis = initial.filter(Boolean);
    firstFrameGated = hasMissingParents(vis);
    firstBuildDone = false;

    // 覆写 posts()：首帧若阻断且未完成，返回空数组，避免渲染原始顺序
    this.stream.posts = () => {
      if (firstFrameGated && !firstBuildDone) {
        return []; // 阻断首帧：显示 Loading，不渲染原始顺序
      }
      if (reorderedPostsCache) return reorderedPostsCache;

      const original = originalPostsMethod.call(this.stream);
      if (!isReordering && original && original.filter(Boolean).length > 0) {
        updateReorderedCache(this, { firstKick: true });
      }
      return original;
    };

    // 初始化计数 & 触发首轮构建
    lastPostCount = vis.length;
    if (lastPostCount > 0) {
      updateReorderedCache(this, { firstKick: true });
    }
  });

  // 组件层：首帧阻断时，给出小 Loading
  extend(PostStream.prototype, 'view', function (vdom) {
    if (firstFrameGated && !firstBuildDone) {
      return (
        <div className="Threadify-FirstFrameGate">
          <LoadingIndicator />
        </div>
      );
    }
    return vdom;
  });

  // 组件层：讨论切换
  extend(PostStream.prototype, 'oncreate', function () {
    const did = this.stream.discussion.id();
    if (currentDiscussionId !== did) {
      resetState(did);
      const cur = originalPostsMethod ? (originalPostsMethod.call(this.stream) || []) : [];
      lastPostCount = cur.filter(Boolean).length;

      // 重新评估是否需要阻断
      firstFrameGated = hasMissingParents(cur.filter(Boolean));
      firstBuildDone = false;

      if (lastPostCount > 0) updateReorderedCache(this, { firstKick: true });
    }
    clearThreadDepthCache();
  });

  // 组件层：可见数量变化则重建（不再阻断，只有首帧阻断）
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

  // 状态层：按线程顺序稳定排序（兜底）
  extend(PostStreamState.prototype, 'visiblePosts', function (result) {
    if (!threadedOrder || !Array.isArray(result) || result.length <= 1) return;
    result.sort((a, b) => {
      const ai = a && a.id ? threadedOrder.get(a.id()) : undefined;
      const bi = b && b.id ? threadedOrder.get(b.id()) : undefined;
      if (ai == null && bi == null) return 0;
      if (ai == null) return 1;
      if (bi == null) return -1;
      return ai - bi;
    });
  });
}

// ----------------- 核心：构建/刷新缓存 -----------------
function updateReorderedCache(postStream, { firstKick = false } = {}) {
  if (isReordering) return;
  isReordering = true;

  try {
    if (!originalPostsMethod) {
      finishWith(null);
      return;
    }

    const originalPosts = originalPostsMethod.call(postStream.stream) || [];
    const validPosts = originalPosts.filter(Boolean);
    if (validPosts.length === 0) {
      finishWith(null);
      return;
    }

    // 若首帧阻断，强制先补齐父帖；否则按常规逻辑
    const ensureParents = ensureParentsLoaded(postStream, validPosts);

    ensureParents
      .then((postsWithParents) =>
        enableMinimalChildLoading
          ? ensureMinimalChildren(postStream, postsWithParents)
          : postsWithParents
      )
      .then((postsReady) => {
        const threaded = createThreadedPosts(postsReady);
        const threadedArray = createThreadedPostsArray(originalPosts, threaded);

        // 建立顺序映射
        threadedOrder = new Map();
        let idx = 0;
        threadedArray.forEach((p) => {
          if (p && p.id) threadedOrder.set(p.id(), idx++);
        });

        finishWith(threadedArray);
      })
      .catch((err) => {
        console.warn('[Threadify] parent/child load failed, fallback threading:', err);
        const threaded = createThreadedPosts(validPosts);
        const threadedArray = createThreadedPostsArray(originalPosts, threaded);

        threadedOrder = new Map();
        let idx = 0;
        threadedArray.forEach((p) => {
          if (p && p.id) threadedOrder.set(p.id(), idx++);
        });

        finishWith(threadedArray);
      });

  } catch (e) {
    console.error('[Threadify] Cache update failed:', e);
    finishWith(null);
  }

  function finishWith(arrayOrNull) {
    reorderedPostsCache = arrayOrNull;
    isReordering = false;
    firstBuildDone = true;   // 解除首帧阻断
    setTimeout(() => m.redraw(), 0);
  }
}

// 维持分页长度：线程顺序 + 末尾 null 占位
function createThreadedPostsArray(originalPosts, threadedPosts) {
  if (!Array.isArray(threadedPosts) || threadedPosts.length === 0) {
    return originalPosts;
  }
  const result = [...threadedPosts];
  const nullsNeeded = Math.max(0, originalPosts.length - threadedPosts.length);
  for (let i = 0; i < nullsNeeded; i++) result.push(null);
  return result;
}

// 判定首屏是否缺父帖
function hasMissingParents(posts) {
  const set = new Set(posts.map((p) => String(p.id())));
  for (const p of posts) {
    const pid = p && p.attribute ? p.attribute('parent_id') : null;
    if (pid && !set.has(String(pid))) return true;
  }
  return false;
}

// ----------------- 父/子帖补全（含本地兜底） -----------------
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

// 兜底：直接通过 API 递归补齐所有缺失父帖
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
    .then((loadedParents) => {
      const combined = [...currentPosts, ...loadedParents];
      // 递归直到没有缺失父帖
      return fallbackLoadParents(combined);
    })
    .catch(() => currentPosts);
}

// ----------------- 状态 & 调试导出 -----------------
export function getThreadedPostsCache() {
  return reorderedPostsCache;
}

export function forceRebuildCache(postStream) {
  reorderedPostsCache = null;
  threadedOrder = null;
  clearThreadDepthCache();
  updateReorderedCache(postStream);
}

export function isThreadingActive() {
  return !!(reorderedPostsCache && originalPostsMethod);
}

export function getThreadingStats() {
  return {
    hasCachedPosts: !!reorderedPostsCache,
    cachedPostCount: reorderedPostsCache ? reorderedPostsCache.filter(Boolean).length : 0,
    isReordering,
    lastPostCount,
    hasOriginalMethod: !!originalPostsMethod,
    discussionId: currentDiscussionId,
    firstFrameGated,
    firstBuildDone,
  };
}

export function getThreadingDebugInfo() {
  const info = getThreadingStats();
  if (reorderedPostsCache) {
    info.sample =
      reorderedPostsCache
        .filter(Boolean)
        .slice(0, 10)
        .map((p) => `#${p.id()}(parent:${p.attribute('parent_id') || 'none'})`) || [];
  }
  return info;
}

export function logThreadingDebug() {
  console.log('[Threadify] Debug:', getThreadingDebugInfo());
}

export function setMinimalChildLoading(enabled) {
  enableMinimalChildLoading = !!enabled;
  console.log(`[Threadify] Minimal child loading ${enableMinimalChildLoading ? 'enabled' : 'disabled'}`);
}

// ----------------- 工具 -----------------
function resetState(discussionId) {
  currentDiscussionId = discussionId;
  isReordering = false;
  reorderedPostsCache = null;
  lastPostCount = 0;
  originalPostsMethod = null;
  threadedOrder = null;
  firstFrameGated = false;
  firstBuildDone = false;
  clearThreadDepthCache();
}
