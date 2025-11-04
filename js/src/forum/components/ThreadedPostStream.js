// js/src/forum/components/ThreadedPostStream.js
/**
 * Threaded PostStream（更安全：覆写 stream.posts() 的返回值）
 *
 * - 不触碰 visiblePosts；仅在“非加载/非锚点期”覆写 this.stream.posts() 的返回值
 * - 排序时保留数组长度与所有占位项（gap/哨兵）的位置
 * - 排序优先级：预取 order > 本地父后子 orderMap > 原序
 * - 预取完成只广播事件，由 PostStream 在空闲帧构建一次本地 orderMap
 */

import app from 'flarum/forum/app';
import { extend } from 'flarum/common/extend';
import PostStream from 'flarum/forum/components/PostStream';

import { createThreadedPosts } from '../utils/ThreadTree';
import { clearThreadDepthCache } from '../utils/ThreadDepth';
import { loadMissingParentPosts, loadMinimalChildren } from '../utils/PostLoader';
import { getOrderIndex, prefetchThreadOrder } from '../utils/ThreadOrderPrefetch';

// ---- 模块级状态 ----------------------------------------------------
let currentDiscussionId = null;
let originalPostsMethod = null;
let building = false;
let orderMap = null;          // Map<postId, order>（本地父后子顺序）
let lastLoadedIdsSig = '';    // 用于判断“已加载集合”是否变化
let cacheSig = '';            // 用于 posts() 返回值缓存
let cachedReturn = null;

// 判忙：翻页 / 邻近锚点加载阶段
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

// 取讨论 id（兼容性）
function getDid(ps) {
  return ps?.stream?.discussion?.id?.() ?? ps?.discussion?.id?.() ?? null;
}

// 等空闲执行（最多 2s）
function waitForIdle(postStream, fn, tries = 40) {
  const state = postStream && postStream.stream;
  if (!state) return fn();
  if (!streamBusy(state)) {
    try { return requestAnimationFrame(() => fn()); } catch { return setTimeout(fn, 0); }
  }
  if (tries <= 0) return;
  setTimeout(() => waitForIdle(postStream, fn, tries - 1), 50);
}

// 构建/重建本地顺序映射（父后子）
function buildOrderMap(postStream) {
  if (building) return;
  building = true;

  const finish = (map) => {
    orderMap = map || null;
    building = false;
    try { m.redraw(); } catch {}
  };

  try {
    const original = originalPostsMethod.call(postStream.stream) || [];
    const posts = original.filter((x) => x && typeof x.id === 'function');
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

// 把“仅帖子项”的排序结果，按原数组占位复装回去
function mergeBackKeepingPlaceholders(originalArray, orderedPostsOnly) {
  const out = new Array(originalArray.length);
  let idx = 0;
  for (let i = 0; i < originalArray.length; i++) {
    const item = originalArray[i];
    const isPost = !!(item && typeof item.id === 'function');
    out[i] = isPost ? orderedPostsOnly[idx++] : item;
  }
  return out;
}

// 依据“预取 + 本地顺序”对帖子项排序（稳定）
function sortPostsOnly(did, postsOnly) {
  const list = postsOnly.slice();
  // 稳定排序：预取优先，再本地父后子；都缺时保持原位
  list.sort((a, b) => {
    const aid = a.id(), bid = b.id();

    const ao = getOrderIndex(did, aid);
    const bo = getOrderIndex(did, bid);
    if (ao != null || bo != null) {
      if (ao == null) return 1;
      if (bo == null) return -1;
      if (ao !== bo) return ao - bo;
    }

    const toA = orderMap?.get?.(aid);
    const toB = orderMap?.get?.(bid);
    if (toA != null || toB != null) {
      if (toA == null) return 1;
      if (toB == null) return -1;
      if (toA !== toB) return toA - toB;
    }

    return 0;
  });
  return list;
}

// 计算“已加载帖子集合”的签名
function idsSignature(arr) {
  return (arr || [])
    .map((x) => (x && typeof x.id === 'function' ? String(x.id()) : '#'))
    .join(',');
}

// ===================================================================
// 初始化：覆写 stream.posts()（仅返回值），并在空闲期构建顺序映射
// ===================================================================
export function initThreadedPostStream() {
  extend(PostStream.prototype, 'oninit', function () {
    const did = getDid(this);
    if (currentDiscussionId !== did) resetState(did);

    if (!originalPostsMethod) originalPostsMethod = this.stream.posts;

    // 预取顺序（命中则更早就位）
    if (did) prefetchThreadOrder(did);

    // 预取完成 → 空闲时构建一次本地顺序映射
    this._threadifyOrderHandler = (ev) => {
      if (String(did) !== String(ev?.detail)) return;
      waitForIdle(this, () => buildOrderMap(this));
    };
    try { window.addEventListener('threadify:orderReady', this._threadifyOrderHandler); } catch {}

    // 首帧后空闲也构建一次（预取未命中时的兜底）
    waitForIdle(this, () => buildOrderMap(this));

    // —— 仅覆写“返回值”：保持长度与占位不变 —— //
    this.stream.posts = () => {
      const original = originalPostsMethod.call(this.stream) || [];

      // 忙碌期：不排序，直接回源
      if (streamBusy(this.stream)) {
        return original;
      }

      const did2 = getDid(this);
      if (!did2 || original.length <= 1) {
        return original;
      }

      // 只拿“帖子项”参与比较；占位（gap/哨兵/null）保持原位
      const postsOnly = original.filter((x) => x && typeof x.id === 'function');
      if (postsOnly.length <= 1) {
        return original;
      }

      // 缓存：按已加载集合 + orderMap.size + did 的签名
      const sig =
        idsSignature(original) +
        '|' +
        (orderMap ? orderMap.size : 0) +
        '|' +
        String(did2);
      if (sig === cacheSig && cachedReturn) {
        return cachedReturn;
      }

      const ordered = sortPostsOnly(did2, postsOnly);
      const merged = mergeBackKeepingPlaceholders(original, ordered);

      cacheSig = sig;
      cachedReturn = merged;
      return merged;
    };
  });

  // 已加载集合变化 → 清缓存并空闲期重建本地顺序映射
  extend(PostStream.prototype, 'onupdate', function () {
    const cur = originalPostsMethod ? originalPostsMethod.call(this.stream) || [] : [];
    const sig = idsSignature(cur);
    if (sig !== lastL
