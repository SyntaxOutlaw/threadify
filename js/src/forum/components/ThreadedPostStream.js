/**
 * Threaded PostStream Component (stable + prefetch + ancestor & children completion)
 *
 * 特性：
 * - 首帧不阻断：首次渲染仍走 Flarum 原序；
 * - 预取全局顺序：/threads-order；
 * - 依据预取映射「向上补齐缺失祖先（最多 N 层）」再「按需补齐子帖（每父帖最多 M 条，整体上限 K）」；
 * - 不改写 visiblePosts（避免 anchorScroll 报错）；
 * - 仅当 PostStream 空闲时重排；
 * - 预取不可用则回退到“补父 + 少量子 + 简易线程化（ThreadTree）”。
 */

import app from 'flarum/forum/app';
import { extend } from 'flarum/common/extend';
import PostStream from 'flarum/forum/components/PostStream';

import { createThreadedPosts } from '../utils/ThreadTree';
import { clearThreadDepthCache } from '../utils/ThreadDepth';
import { loadMissingParentPosts, loadMinimalChildren } from '../utils/PostLoader';
import {
  prefetchThreadOrder,
  getOrderIndex,
  getParentPrefetched,
  isPrefetched,
  collectChildrenIdsForParents,
} from '../utils/ThreadOrderPrefetch';

// ---- 配置 -----------------------------------------------------------
const MAX_ANCESTOR_STEPS = 3;        // 追溯祖先层数上限
const CHILD_LIMIT_PER_PARENT = 8;    // 每个父帖最多补多少子帖
const CHILD_MAX_TOTAL = 40;          // 本次最多补多少子帖
const ENABLE_MINIMAL_CHILD_LOADING = true; // 预取缺失时的后备策略

// ---- 模块级状态 ----------------------------------------------------
let isReordering = false;
let reorderedPostsCache = null;
let lastPostCount = 0;
let originalPostsMethod = null;
let currentDiscussionId = null;

// ---- 工具：判定流是否忙碌（翻页/锚点附近加载等） --------------------
function streamBusy(state) {
  if (!state) return false;
  return !!(
    state.loading ||
    state.loadingPrevious ||
    state.loadingNext ||
    state.loadingNear ||
    state._loadingPrevious ||
    state._loadingNext
  );
}

// ===================================================================
// 初始化
// ===================================================================
export function initThreadedPostStream() {
  extend(PostStream.prototype, 'oninit', function () {
    const did = this.stream.discussion && this.stream.discussion.id && this.stream.discussion.id();
    if (currentDiscussionId !== did) resetState(did);

    if (!originalPostsMethod) originalPostsMethod = this.stream.posts;

    if (did) prefetchThreadOrder(did);

    this.stream.posts = () => {
      if (reorderedPostsCache) return reorderedPostsCache;

      const original = originalPostsMethod.call(this.stream) || [];
      if (!isReordering && original.filter(Boolean).length > 0) {
        buildCacheWithPrefetch(this);
      }
      return original;
    };

    const cur = originalPostsMethod.call(this.stream) || [];
    lastPostCount = cur.filter(Boolean).length;
    if (lastPostCount > 0) buildCacheWithPrefetch(this);
  });

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
        setTimeout(() => {
          if (!streamBusy(this.stream)) buildCacheWithPrefetch(this);
        }, 60);
      }
    }
  });

  // 预取就绪时尝试重建（避免同帧与 anchorScroll 打架）
  window.addEventListener('threadify:orderReady', (ev) => {
    const did = ev?.detail;
    if (!did || did !== currentDiscussionId) return;
    setTimeout(() => {
      try {
        if (!isReordering && !reorderedPostsCache) buildCacheWithPrefetch(this);
      } catch {}
    }, 0);
  });
}

// ===================================================================
// 核心：预取顺序 + 祖先补齐 + 子帖补齐 -> 稳定重排
// ===================================================================
function buildCacheWithPrefetch(postStream) {
  if (isReordering) return;
  isReordering = true;

  const finish = (arr) => {
    reorderedPostsCache = arr;
    isReordering = false;
    setTimeout(() => { try { m.redraw(); } catch {} }, 0);
  };

  try {
    if (!originalPostsMethod) return finish(null);

    const originalPosts = originalPostsMethod.call(postStream.stream) || [];
    const validPosts = originalPosts.filter(Boolean);
    if (validPosts.length === 0) return finish(null);

    const did = postStream.stream.discussion && postStream.stream.discussion.id && postStream.stream.discussion.id();

    const build = () =>
      ensureAncestorsByPrefetch(did, validPosts)
        .then((withAncestors) => ensureChildrenByPrefetch(did, withAncestors))
        .then((ready) => {
          const sorted = sortByPrefetchOrder(did, ready);
          if (sorted && sorted.length) {
            const threadedArray = padNullsToLength(sorted, originalPosts.length);
            finish(threadedArray);
            return;
          }

          // —— 预取不可用或无映射命中：回退 —— //
          ensureParentsLoaded(postStream, validPosts)
            .then((postsWithParents) =>
              ENABLE_MINIMAL_CHILD_LOADING
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

    if (did && !isPrefetched(did)) {
      prefetchThreadOrder(did).finally(build);
    } else {
      build();
    }
  } catch (e) {
    console.error('[Threadify] buildCacheWithPrefetch failed:', e);
    isReordering = false;
  }
}

// —— 祖先补齐（最多 MAX_ANCESTOR_STEPS 层） ——
function ensureAncestorsByPrefetch(discussionId, posts) {
  return new Promise((resolve) => {
    if (!discussionId || !Array.isArray(posts) || posts.length === 0) return resolve(posts);

    const loaded = new Set(posts.map((p) => String(p.id && p.id())));
    const toFetch = new Set();

    for (const p of posts) {
      let step = 0;
      let cur = p && p.id && Number(p.id());
      while (cur && step < MAX_ANCESTOR_STEPS) {
        const parent = getParentPrefetched(discussionId, cur);
        if (!parent) break;
        if (!loaded.has(String(parent))) toFetch.add(String(parent));
        cur = parent;
        step++;
      }
    }

    if (toFetch.size === 0) return resolve(posts);

    app.store
      .find('posts', { filter: { id: Array.from(toFetch).join(',') } })
      .then((loadedParents) => {
        const map = new Map(posts.map((p) => [String(p.id && p.id()), p]));
        for (const lp of loadedParents || []) {
          const id = String(lp.id && lp.id());
          if (!map.has(id)) map.set(id, lp);
        }
        resolve(Array.from(map.values()));
      })
      .catch(() => resolve(posts));
  });
}

// —— 子帖补齐（依据预取映射为当前已加载的父帖拉取若干“远在后面的子帖”） ——
function ensureChildrenByPrefetch(discussionId, posts) {
  return new Promise((resolve) => {
    if (!discussionId || !Array.isArray(posts) || posts.length === 0) return resolve(posts);

    const loadedIds = new Set(posts.map((p) => String(p.id && p.id())));
    const parentIds = new Set(posts.map((p) => p && p.id && Number(p.id())));

    const childrenIds = collectChildrenIdsForParents(
      discussionId,
      parentIds,
      CHILD_LIMIT_PER_PARENT,
      'latest',
      CHILD_MAX_TOTAL
    );

    // 过滤掉已加载的
    const toFetch = childrenIds.filter((id) => !loadedIds.has(String(id)));
    if (toFetch.length === 0) return resolve(posts);

    app.store
      .find('posts', { filter: { id: toFetch.join(',') } })
      .then((loadedChildren) => resolve([...posts, ...(loadedChildren || [])]))
      .catch(() => resolve(posts));
  });
}

// —— 用预取顺序排序（只重排“已加载的帖子”） ——
function sortByPrefetchOrder(discussionId, posts) {
  if (!discussionId || !Array.isArray(posts) || posts.length === 0) return null;
  const hit = posts.some((p) => getOrderIndex(discussionId, p.id && p.id()) != null);
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
    return 0; // 稳定排序：都没有映射则保持相对顺序
  });

  return list;
}

// —— 维持原数组长度（分页位）——不足用 null 填充 ——
function padNullsToLength(arr, targetLen) {
  const result = Array.isArray(arr) ? arr.slice() : [];
  const need = Math.max(0, targetLen - result.length);
  for (let i = 0; i < need; i++) result.push(null);
  return result;
}

// ---- 后备加载（无预取时） ------------------------------------------
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
