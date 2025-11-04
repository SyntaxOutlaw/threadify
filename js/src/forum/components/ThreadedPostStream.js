// js/src/forum/components/ThreadedPostStream.js
/**
 * Threaded PostStream (safe & working)
 * - 不改写 stream.posts()，不产生 null
 * - 仅在 PostStreamState.visiblePosts() 做稳定排序（父后子）
 * - 使用 override 真正返回排序后的数组
 * - 加载期（翻页/锚点）不排序，避免与 anchorScroll 竞争
 * - 预取顺序优先；本地线程顺序为兜底
 * - 首帧原序，空闲后构建顺序映射并一次性稳定
 */

import app from 'flarum/forum/app';
import { extend, override } from 'flarum/common/extend';
import PostStream from 'flarum/forum/components/PostStream';
import PostStreamState from 'flarum/forum/states/PostStreamState';

import { createThreadedPosts } from '../utils/ThreadTree';
import { clearThreadDepthCache } from '../utils/ThreadDepth';
import { loadMissingParentPosts, loadMinimalChildren } from '../utils/PostLoader';
import { getOrderIndex, prefetchThreadOrder } from '../utils/ThreadOrderPrefetch';

// ---- 模块状态 ------------------------------------------------------
let building = false;
let orderMap = null;            // Map<postId, order>
let currentDiscussionId = null;
let lastLoadedPostIds = '';

// 判定 PostStream 是否忙碌（翻页/锚点附近加载）
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

// 等待空闲后执行（最多 ~2s，50ms 间隔）
function waitForIdle(postStream, fn, tries = 40) {
  const state = postStream && postStream.stream;
  if (!state) return fn();
  if (!streamBusy(state)) {
    try { return requestAnimationFrame(() => fn()); } catch { return setTimeout(fn, 0); }
  }
  if (tries <= 0) return;
  setTimeout(() => waitForIdle(postStream, fn, tries - 1), 50);
}

// ---------- 顺序映射构建：补父/少量子 → 线程化 → Map(postId → order) ----------
function buildOrderMap(postStream) {
  if (building) return;
  building = true;

  const finish = (map) => {
    orderMap = map || null;
    building = false;
    try { m.redraw(); } catch {}
  };

  try {
    const original = postStream.stream.posts() || [];
    const posts = original.filter((p) => p && typeof p.id === 'function');
    if (posts.length === 0) return finish(null);

    const ctx = postStream.discussion ? postStream : { discussion: postStream.stream.discussion };

    loadMissingParentPosts(ctx, posts)
      .then((withParents) => loadMinimalChildren(ctx, withParents).catch(() => withParents))
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

// ===================================================================
// 初始化：挂接 PostStream 生命周期 & 可见列表排序
// ===================================================================
export function initThreadedPostStream() {
  extend(PostStream.prototype, 'oninit', function () {
    const did = this.stream.discussion?.id?.();
    if (currentDiscussionId !== did) resetState(did);

    if (did) prefetchThreadOrder(did);

    // 预取完成 → 空闲后构建一次映射
    this._threadifyOrderHandler = (ev) => {
      if (String(did) !== String(ev?.detail)) return;
      waitForIdle(this, () => buildOrderMap(this));
    };
    try { window.addEventListener('threadify:orderReady', this._threadifyOrderHandler); } catch {}

    // 首帧结束后构建一次映射（不阻断首帧）
    waitForIdle(this, () => buildOrderMap(this));
  });

  // 已加载帖子集变化 → 重新构建顺序映射
  extend(PostStream.prototype, 'onupdate', function () {
    const ids = (this.stream.posts() || [])
      .filter((p) => p && typeof p.id === 'function')
      .map((p) => p.id())
      .join(',');
    if (ids !== lastLoadedPostIds) {
      lastLoadedPostIds = ids;
      clearThreadDepthCache();
      waitForIdle(this, () => buildOrderMap(this));
    }
  });

  // 清理监听
  extend(PostStream.prototype, 'onremove', function () {
    try {
      if (this._threadifyOrderHandler) {
        window.removeEventListener('threadify:orderReady', this._threadifyOrderHandler);
        this._threadifyOrderHandler = null;
      }
    } catch {}
  });

  // —— 用 override 真正返回我们的排序结果 —— //
  override(PostStreamState.prototype, 'visiblePosts', function (original) {
    const result = original.call(this);

    // 加载/锚点期不排序
    if (streamBusy(this)) return result;

    const did = this.discussion?.id?.();
    if (!did || !Array.isArray(result) || result.length <= 1) return result;

    const arr = result.slice();

    arr.sort((a, b) => {
      const isPostA = !!(a && typeof a.id === 'function');
      const isPostB = !!(b && typeof b.id === 'function');
      if (!isPostA || !isPostB) return 0; // gap/占位符原位

      const aid = a.id();
      const bid = b.id();

      // 1) 预取顺序优先（进入即位）
      const ao = getOrderIndex(did, aid);
      const bo = getOrderIndex(did, bid);
      if (ao != null || bo != null) {
        if (ao == null) return 1;
        if (bo == null) return -1;
        if (ao !== bo) return ao - bo;
      }

      // 2) 本地“父后子”顺序映射
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

// ---- 调试导出 ------------------------------------------------------
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
