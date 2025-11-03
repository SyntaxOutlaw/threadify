/**
 * Threaded PostStream Component Extensions (FIXED)
 *
 * 要点：
 * 1) 始终在建树前补齐缺失父帖（必要时再保守补少量子帖），保证 3545→3534 这类关系可被前端正确归组。
 * 2) 双保险接管顺序：
 *    - 覆写 this.stream.posts() 返回线程化数组（与旧管线一致）
 *    - 再在 PostStreamState.visiblePosts 上按线程顺序稳定排序（防止其他扩展覆盖视图逻辑）
 */

import app from 'flarum/forum/app';
import { extend } from 'flarum/common/extend';
import PostStream from 'flarum/forum/components/PostStream';
import PostStreamState from 'flarum/forum/states/PostStreamState';

import { createThreadedPosts } from '../utils/ThreadTree';
import { clearThreadDepthCache } from '../utils/ThreadDepth';
import { loadMissingParentPosts, loadMinimalChildren } from '../utils/PostLoader';

// -------- 全局状态（本组件生命周期内共享） --------
let isReordering = false;                 // 防止重入
let reorderedPostsCache = null;           // 线程化后的数组（含 null 占位以维持分页长度）
let lastPostCount = 0;                    // 上次可见帖子数量
let originalPostsMethod = null;           // 保存原始 this.stream.posts
let currentDiscussionId = null;           // 当前讨论 ID
let threadedOrder = null;                 // Map<postId, orderIndex>，用于状态层排序兜底
let enableMinimalChildLoading = true;     // 默认开启“保守子帖补全”

// ----------------- 入口：注册所有钩子 -----------------
export function initThreadedPostStream() {
  // 组件层：初始化时覆写 this.stream.posts，并触发首轮重建
  extend(PostStream.prototype, 'oninit', function () {
    const did = this.stream.discussion.id();
    if (currentDiscussionId !== did) {
      resetState(did);
    }

    // 保存原始 posts() 并覆写为我们的代理
    if (!originalPostsMethod) originalPostsMethod = this.stream.posts;

    this.stream.posts = () => {
      if (reorderedPostsCache) {
        return reorderedPostsCache;
      }
      const original = originalPostsMethod.call(this.stream);
      // 若还没缓存，异步重建一次
      if (!isReordering && original && original.filter(Boolean).length > 0) {
        updateReorderedCache(this);
      }
      return original;
    };

    // 初始化计数并触发首次构建
    const current = originalPostsMethod.call(this.stream) || [];
    lastPostCount = current.filter(Boolean).length;
    if (lastPostCount > 0) updateReorderedCache(this);
  });

  // 组件层：讨论切换时清理缓存
  extend(PostStream.prototype, 'oncreate', function () {
    const did = this.stream.discussion.id();
    if (currentDiscussionId !== did) {
      resetState(did);
      // 新讨论首屏构建
      const cur = originalPostsMethod ? (originalPostsMethod.call(this.stream) || []) : [];
      lastPostCount = cur.filter(Boolean).length;
      if (lastPostCount > 0) updateReorderedCache(this);
    }
    clearThreadDepthCache();
  });

  // 组件层：可见帖子数量变化则重建
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

  // 状态层：真正决定“可见顺序”的地方——按 threadedOrder 稳定排序（兜底）
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
function updateReorderedCache(postStream) {
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

    // 1) 先补父帖（递归到根）
    ensureParentsLoaded(postStream, validPosts)
      // 2) 可选：再保守补少量子帖，减少首屏“跳动”
      .then((postsWithParents) =>
        enableMinimalChildLoading
          ? ensureMinimalChildren(postStream, postsWithParents)
          : postsWithParents
      )
      // 3) 基于“父后跟子（各层内按时间升序）”线性化为线程顺序
      .then((postsReady) => {
        const threaded = createThreadedPosts(postsReady);
        const threadedArray = createThreadedPostsArray(originalPosts, threaded);

        // 建立 postId->顺序索引，供状态层排序兜底
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
    // 触发重绘
    setTimeout(() => m.redraw(), 0);
  }
}

// 维持分页长度：线程顺序 + 末尾填充 null 占位
function createThreadedPostsArray(originalPosts, threadedPosts) {
  if (!Array.isArray(threadedPosts) || threadedPosts.length === 0) {
    return originalPosts;
  }
  const result = [...threadedPosts];
  const nullsNeeded = Math.max(0, originalPosts.length - threadedPosts.length);
  for (let i = 0; i < nullsNeeded; i++) result.push(null);
  return result;
}

// ----------------- 父/子帖补全（含本地兜底） -----------------
function ensureParentsLoaded(postStream, posts) {
  // 优先使用工具模块；若失败/不存在，则走本地兜底
  if (typeof loadMissingParentPosts === 'function') {
    // 兼容 PostLoader 对入参的期望：需要 discussion 属性
    const ctx = postStream.discussion
      ? postStream
      : { discussion: postStream.stream.discussion };
    return loadMissingParentPosts(ctx, posts).catch(() => fallbackLoadParents(posts));
  }
  return fallbackLoadParents(posts);
}

function ensureMinimalChildren(postStream, posts) {
  if (typeof loadMinimalChildren === 'function') {
    const ctx = postStream.discussion
      ? postStream
      : { discussion: postStream.stream.discussion };
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

// ----------------- 状态 & 调试导出（与原版保持兼容） -----------------
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
  clearThreadDepthCache();
}

