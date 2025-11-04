// js/src/forum/components/ThreadedPostStream.js
/**
 * Threaded PostStream（安全 + 可把远处子楼提前到父楼下）
 *
 * - 不触碰 visiblePosts；仅在“非加载/非锚点期”覆写 this.stream.posts() 的返回值
 * - 允许把帖子填入原本为 null 的占位位（非帖子哨兵保持原位）
 * - 排序优先级：预取 order > 本地父后子 orderMap > 原序
 * - 预取完成只广播事件，由 PostStream 在空闲帧构建一次本地 orderMap
 * - 额外：利用预取表“定向补子楼”（最多 20 条）避免久远子楼缺席
 */

import app from 'flarum/forum/app';
import { extend } from 'flarum/common/extend';
import PostStream from 'flarum/forum/components/PostStream';

import { createThreadedPosts } from '../utils/ThreadTree';
import { clearThreadDepthCache } from '../utils/ThreadDepth';
import { loadMissingParentPosts } from '../utils/PostLoader';
import {
  getOrderIndex,
  prefetchThreadOrder,
  getParentPrefetched,
} from '../utils/ThreadOrderPrefetch';

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
  const stream = ps && ps.stream;
  const disc = stream && stream.discussion;
  return disc && disc.id && disc.id();
}

// 等空闲执行（最多 2s）
function waitForIdle(postStream, fn, tries = 40) {
  const state = postStream && postStream.stream;
  if (!state) return fn();
  if (!streamBusy(state)) {
    try { return requestAnimationFrame(() => fn()); } catch (e) { return setTimeout(fn, 0); }
  }
  if (tries <= 0) return;
  setTimeout(() => waitForIdle(postStream, fn, tries - 1), 50);
}

// 计算“已加载帖子集合”的签名
function idsSignature(arr) {
  return (arr || [])
    .map((x) => (x && typeof x.id === 'function' ? String(x.id()) : '#'))
    .join(',');
}

// ---------- 依据“预取 + 本地顺序”对帖子项排序（稳定） ----------
function sortPostsOnly(did, postsOnly) {
  const list = postsOnly.slice();
  list.sort((a, b) => {
    const aid = a.id();
    const bid = b.id();

    const ao = getOrderIndex(did, aid);
    const bo = getOrderIndex(did, bid);
    if (ao != null || bo != null) {
      if (ao == null) return 1;
      if (bo == null) return -1;
      if (ao !== bo) return ao - bo;
    }

    const toA = orderMap && orderMap.get && orderMap.get(aid);
    const toB = orderMap && orderMap.get && orderMap.get(bid);
    if (toA != null || toB != null) {
      if (toA == null) return 1;
      if (toB == null) return -1;
      if (toA !== toB) return toA - toB;
    }

    return 0;
  });
  return list;
}

// ---------- 把排序后的“帖子项”灌回原数组（允许占位 null 被帖子顶替） ----------
function mergeBackIntoPostCapableSlots(originalArray, orderedPostsOnly) {
  const out = new Array(originalArray.length);
  let idx = 0;
  for (let i = 0; i < originalArray.length; i++) {
    const item = originalArray[i];
    const isPost = !!(item && typeof item.id === 'function');
    const isPostCapable = isPost || item == null; // 允许用 Post 顶替 null
    out[i] = isPostCapable ? (idx < orderedPostsOnly.length ? orderedPostsOnly[idx++] : null) : item;
  }
  return out;
}

// ---------- 按预取表“定向补子楼”（父已在集合、子不在集合） ----------
async function ensurePrefetchedChildren(postStream, did, posts) {
  const discussion = postStream?.stream?.discussion;
  if (!discussion || typeof discussion.postIds !== 'function') return posts;

  const idSet = new Set(posts.filter(Boolean).map((p) => String(p.id())));
  const allIds = (discussion.postIds() || []).map((x) => String(x));
  const missing = [];

  // 最多拉取 20 条“父已加载”的子楼
  for (let i = 0; i < allIds.length && missing.length < 20; i++) {
    const id = allIds[i];
    if (!id || idSet.has(id)) continue;
    const parent = getParentPrefetched(did, Number(id));
    if (parent != null && idSet.has(String(parent))) {
      missing.push(id);
    }
  }

  if (missing.length === 0) return posts;

  try {
    const loaded = await app.store.find('posts', { filter: { id: missing.join(',') } });
    // 合并去重
    const map = new Map();
    posts.filter(Boolean).forEach((p) => map.set(String(p.id()), p));
    (loaded || []).filter(Boolean).forEach((p) => map.set(String(p.id()), p));
    return Array.from(map.values());
  } catch (e) {
    console.warn('[Threadify] ensurePrefetchedChildren failed', e);
    return posts;
  }
}

// ---------- 构建/重建本地顺序映射（父后子） ----------
function buildOrderMap(postStream) {
  if (building) return;
  building = true;

  const finish = (map) => {
    orderMap = map || null;
    building = false;
    try { m.redraw(); } catch (e) {}
  };

  (async () => {
    try {
      const original = originalPostsMethod ? (originalPostsMethod.call(postStream.stream) || []) : [];
      const posts = original.filter((x) => x && typeof x.id === 'function');
      if (posts.length === 0) return finish(null);

      const ctx = postStream.discussion ? postStream : { discussion: postStream.stream.discussion };
      const did = getDid(postStream);

      // 先补父，再按预取表定向补子楼
      let ready = await loadMissingParentPosts(ctx, posts).catch(() => posts);
      ready = await ensurePrefetchedChildren(postStream, did, ready).catch(() => ready);

      const threaded = createThreadedPosts(ready);
      const map = new Map();
      let i = 0;
      threaded.forEach((p) => { if (p && typeof p.id === 'function') map.set(p.id(), i++); });
      finish(map);
    } catch (e) {
      console.error('[Threadify] buildOrderMap failed:', e);
      finish(null);
    }
  })();
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
      const readyDid = ev && ev.detail;
      if (String(did) !== String(readyDid)) return;
      waitForIdle(this, () => buildOrderMap(this));
    };
    try { window.addEventListener('threadify:orderReady', this._threadifyOrderHandler); } catch (e) {}

    // 首帧后空闲也构建一次（预取未命中时的兜底）
    waitForIdle(this, () => buildOrderMap(this));

    // —— 覆写“返回值”：可把帖子灌入 null 占位，但不动其它哨兵 —— //
    this.stream.posts = () => {
      const original = originalPostsMethod ? (originalPostsMethod.call(this.stream) || []) : [];

      // 忙碌期：不排序，直接回源
      if (streamBusy(this.stream)) {
        return original;
      }

      const did2 = getDid(this);
      if (!did2 || original.length <= 1) {
        return original;
      }

      // 拿“帖子项”参与比较；非帖子哨兵保持原位
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
      const merged = mergeBackIntoPostCapableSlots(original, ordered);

      cacheSig = sig;
      cachedReturn = merged;
      return merged;
    };
  });

  // 已加载集合变化 → 清缓存并空闲期重建本地顺序映射
  extend(PostStream.prototype, 'onupdate', function () {
    const cur = originalPostsMethod ? (originalPostsMethod.call(this.stream) || []) : [];
    const sig = idsSignature(cur);
    if (sig !== lastLoadedIdsSig) {
      lastLoadedIdsSig = sig;
      cacheSig = '';
      cachedReturn = null;
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
    } catch (e) {}
  });
}

// ---- 调试导出（可选） ----------------------------------------------
export function isThreadingActive() { return !!orderMap; }
export function getThreadingStats() {
  return { hasOrderMap: !!orderMap, building, discussionId: currentDiscussionId };
}

function resetState(discussionId) {
  currentDiscussionId = discussionId || null;
  originalPostsMethod = null;
  orderMap = null;
  building = false;
  lastLoadedIdsSig = '';
  cacheSig = '';
  cachedReturn = null;
  clearThreadDepthCache();
}
