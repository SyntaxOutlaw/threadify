// js/src/forum/components/ThreadedPostStream.js
/**
 * Threaded PostStream (safe: no first-frame reorder, no null padding)
 *
 * - 不改写 stream.posts()；仅在 visiblePosts() 上做稳定排序
 * - 只比较“帖子模型”之间；gap/占位符保持原位
 * - 预取顺序优先；线程顺序用作兜底
 * - 构建的仅是 orderMap，不返回“排序后的数组”
 */

import app from 'flarum/forum/app';
import { extend } from 'flarum/common/extend';
import PostStream from 'flarum/forum/components/PostStream';
import PostStreamState from 'flarum/forum/states/PostStreamState';

import { createThreadedPosts } from '../utils/ThreadTree';
import { clearThreadDepthCache } from '../utils/ThreadDepth';
import { loadMissingParentPosts, loadMinimalChildren } from '../utils/PostLoader';
import { getOrderIndex, prefetchThreadOrder } from '../utils/ThreadOrderPrefetch';

// ----- 模块级状态（仅顺序映射）-----
let building = false;
let orderMap = null;              // Map<postId, order>
let currentDiscussionId = null;
let lastLoadedPostIds = '';

export function initThreadedPostStream() {
  extend(PostStream.prototype, 'oninit', function () {
    const did = this.stream.discussion?.id?.();
    if (currentDiscussionId !== did) resetState(did);

    // 预取轻量顺序（进入即位）
    if (did) prefetchThreadOrder(did);

    // 基于当前已加载的帖子构建顺序映射
    buildOrderMap(this);
  });

  // 加载集变化 → 重新构建顺序映射（不触碰流本体）
  extend(PostStream.prototype, 'onupdate', function () {
    const ids = (this.stream.posts() || [])
      .filter((p) => p && typeof p.id === 'function')
      .map((p) => p.id())
      .join(',');
    if (ids !== lastLoadedPostIds) {
      lastLoadedPostIds = ids;
      clearThreadDepthCache();
      buildOrderMap(this);
    }
  });

  // 只在“非加载期”对可见列表做稳定排序（gap/占位符不动）
  extend(PostStreamState.prototype, 'visiblePosts', function (result) {
    if (!Array.isArray(result) || result.length <= 1) return result;

    // 避免与 _loadPrevious/_loadNext/锚点跳转冲突
    const loadingLike = Object.keys(this).some((k) => /^loading/i.test(k) && this[k]);
    if (loadingLike) return result;

    const did = this.discussion?.id?.();
    if (!did) return result;

    const arr = result.slice();

    arr.sort((a, b) => {
      const isPostA = !!(a && typeof a.id === 'function');
      const isPostB = !!(b && typeof b.id === 'function');
      if (!isPostA || !isPostB) return 0; // gap/占位符原位

      const aid = a.id();
      const bid = b.id();

      // 1) 预取顺序优先
      const ao = getOrderIndex(did, aid);
      const bo = getOrderIndex(did, bid);
      if (ao != null || bo != null) {
        if (ao == null) return 1;
        if (bo == null) return -1;
        if (ao !== bo) return ao - bo;
      }

      // 2) 线程顺序映射
      const toA = orderMap?.get?.(aid);
      const toB = orderMap?.get?.(bid);
      if (toA != null || toB != null) {
        if (toA == null) return 1;
        if (toB == null) return -1;
        if (toA !== toB) return toA - toB;
      }

      // 3) 其他情况保持原位（稳定排序）
      return 0;
    });

    return arr;
  });
}

// ---------- 顺序映射构建：补父/少量子 → 线程化 → Map(postId → order) ----------
function buildOrderMap(postStream) {
  if (building) return;
  building = true;

  const finish = (map) => {
    orderMap = map || null;
    building = false;
    try { m.redraw(); } catch (e) {}
  };

  try {
    const original = postStream.stream.posts() || [];
    const posts = original.filter((p) => p && typeof p.id === 'function');
    if (posts.length === 0) return finish(null);

    ensureParentsLoaded(postStream, posts)
      .then((withParents) => ensureMinimalChildren(postStream, withParents))
      .then((ready) => {
        const threaded = createThreadedPosts(ready);
        const map = new Map();
        let i = 0;
        threaded.forEach((p) => { if (p && typeof p.id === 'function') map.set(p.id(), i++); });
        finish(map);
      })
      .catch(() => {
        const threaded = createThreadedPosts(posts);
        const map = new Map();
        let i = 0;
        threaded.forEach((p) => { if (p && typeof p.id === 'function') map.set(p.id(), i++); });
        finish(map);
      });
  } catch (e) {
    console.error('[Threadify] buildOrderMap failed:', e);
    finish(null);
  }
}

// 父帖/子帖补齐（失败不致命）
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
    return loadMinimalChildren(ctx, posts).catch(() => posts);
  }
  return Promise.resolve(posts);
}

// 对外工具（调试用）
export function isThreadingActive() { return !!orderMap; }
export function getThreadingStats() {
  return { hasOrderMap: !!orderMap, building, discussionId: currentDiscussionId };
}

function resetState(discussionId) {
  currentDiscussionId = discussionId || null;
  orderMap = null;
  building = false;
  lastLoadedPostIds = '';
  clearThreadDepthCache();
}
