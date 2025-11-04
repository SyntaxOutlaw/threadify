// js/src/forum/components/ThreadedPostStream.js
/**
 * Threaded PostStream（安全 + 远处子楼前置）
 *
 * - 不触碰 visiblePosts；覆写 this.stream.posts() 的返回值（仅在空闲期）
 * - 引入 extraChildrenPool：按预取表定向拉取“父已在场”的子楼，最多 200 条
 * - 合并时允许用 Post 顶替 null 槽位（不动其它哨兵项）
 * - 排序优先级：预取 order > 本地父后子 orderMap > 原序
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
  isPrefetched,
} from '../utils/ThreadOrderPrefetch';

// ---- 模块级状态 ----------------------------------------------------
let currentDiscussionId = null;
let originalPostsMethod = null;
let building = false;
let orderMap = null;               // Map<postId, order>（本地父后子顺序）
let lastLoadedIdsSig = '';         // 判断“已加载集合”是否变化
let cacheSig = '';                 // posts() 返回值缓存签名
let cachedReturn = null;
let extraChildrenPool = new Map(); // Map<postId, Post> 仅存“父在场”的子楼（上限 200）

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

// ---------- 把排序后的“帖子项”灌回原数组（允许 Post 顶替 null） ----------
function mergeBackIntoPostCapableSlots(originalArray, orderedPostsOnly) {
  const out = new Array(originalArray.length);
  let idx = 0;
  for (let i = 0; i < originalArray.length; i++) {
    const item = originalArray[i];
    const isPost = !!(item && typeof item.id === 'function');
    const isPostCapable = isPost || item == null; // 允许用 Post 顶替 null；其它哨兵保留
    out[i] = isPostCapable ? (idx < orderedPostsOnly.length ? orderedPostsOnly[idx++] : (isPost ? null : item)) : item;
  }
  return out;
}

// ---------- 定向补子楼：父在场且子不在场 → 拉取进池（最多 200） ----------
async function ensurePrefetchedChildrenPool(postStream) {
  const did = getDid(postStream);
  if (!did || !isPrefetched(did)) return;

  const discussion = postStream?.stream?.discussion;
  if (!discussion || typeof discussion.postIds !== 'function') return;

  // 当前已在数组中的帖子 id 集合
  const original = originalPostsMethod ? (originalPostsMethod.call(postStream.stream) || []) : [];
  const curIdSet = new Set(original.filter((x) => x && typeof x.id === 'function').map((p) => String(p.id())));

  // 遍历全部 postIds，根据预取表判断 parentId
  const allIds = (discussion.postIds() || []).map((x) => Number(x));
  const targets = [];
  for (let i = 0; i < allIds.length; i++) {
    const id = allIds[i];
    if (!id || curIdSet.has(String(id)) || extraChildrenPool.has(id)) continue;
    const parent = getParentPrefetched(did, id);
    if (parent != null && curIdSet.has(String(parent))) {
      targets.push(id);
      if (targets.length >= 50) break; // 单次最多拉 50，累计池上限 200
    }
  }
  if (targets.length === 0) return;

  try {
    const loaded = await app.store.find('posts', { filter: { id: targets.join(',') } });
    for (const p of loaded || []) {
      if (!p || typeof p.id !== 'function') continue;
      const pid = Number(p.id());
      if (!extraChildrenPool.has(pid)) {
        extraChildrenPool.set(pid, p);
        if (extraChildrenPool.size > 200) {
          // 简单淘汰：删最早插入的
          const firstKey = extraChildrenPool.keys().next().value;
          extraChildrenPool.delete(firstKey);
        }
      }
    }
  } catch (e) {
    console.warn('[Threadify] ensurePrefetchedChildrenPool failed', e);
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

      // 先补父，再维护“补子楼池”
      let ready = await loadMissingParentPosts(ctx, posts).catch(() => posts);
      await ensurePrefetchedChildrenPool(postStream);

      // 并集 = 当前帖子 + 池中子楼（去重）
      const seen = new Set(ready.map((p) => String(p.id())));
      for (const p of extraChildrenPool.values()) {
        const pid = String(p.id());
        if (!seen.has(pid)) {
          ready.push(p);
          seen.add(pid);
        }
      }

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

    // 预取完成 → 空闲时构建一次本地顺序映射 + 维护子楼池
    this._threadifyOrderHandler = (ev) => {
      const readyDid = ev && ev.detail;
      if (String(did) !== String(readyDid)) return;
      waitForIdle(this, () => {
        ensurePrefetchedChildrenPool(this).then(() => buildOrderMap(this));
      });
    };
    try { window.addEventListener('threadify:orderReady', this._threadifyOrderHandler); } catch (e) {}

    // 首帧后空闲也构建一次（预取未命中时的兜底）
    waitForIdle(this, () => buildOrderMap(this));

    // —— 覆写“返回值”：可用 Post 顶替 null 槽位，但不动其它哨兵 —— //
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

      // 只拿“帖子项”参与比较；并与补子楼池做并集（容量由可用槽位限制）
      const postsOnly = original.filter((x) => x && typeof x.id === 'function');
      if (postsOnly.length <= 1) {
        return original;
      }

      // 可用于放帖的槽位数 = 已有帖子数 + null 数
      const nullSlots = original.reduce((n, x) => (x == null ? n + 1 : n), 0);
      const cap = postsOnly.length + nullSlots;

      // 并集：当前帖子 + 池中子楼（去重、限额）
      const union = postsOnly.slice();
      const seen = new Set(postsOnly.map((p) => String(p.id())));
      for (const p of extraChildrenPool.values()) {
        const pid = String(p.id());
        if (!seen.has(pid)) {
          union.push(p);
          seen.add(pid);
          if (union.length >= cap) break;
        }
      }

      // 缓存：按已加载集合 + orderMap.size + 池大小 + did 的签名
      const sig =
        idsSignature(original) +
        '|' +
        (orderMap ? orderMap.size : 0) +
        '|' +
        extraChildrenPool.size +
        '|' +
        String(did2);
      if (sig === cacheSig && cachedReturn) {
        return cachedReturn;
      }

      const ordered = sortPostsOnly(did2, union);
      const merged = mergeBackIntoPostCapableSlots(original, ordered);

      cacheSig = sig;
      cachedReturn = merged;
      return merged;
    };
  });

  // 已加载集合变化 → 清缓存并空闲期重建本地顺序映射 + 更新子楼池
  extend(PostStream.prototype, 'onupdate', function () {
    const cur = originalPostsMethod ? (originalPostsMethod.call(this.stream) || []) : [];
    const sig = idsSignature(cur);
    if (sig !== lastLoadedIdsSig) {
      lastLoadedIdsSig = sig;
      cacheSig = '';
      cachedReturn = null;
      clearThreadDepthCache();
      waitForIdle(this, () => {
        ensurePrefetchedChildrenPool(this).then(() => buildOrderMap(this));
      });
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
  return {
    hasOrderMap: !!orderMap,
    building,
    discussionId: currentDiscussionId,
    extraChildrenPoolSize: extraChildrenPool.size,
  };
}

function resetState(discussionId) {
  currentDiscussionId = discussionId || null;
  originalPostsMethod = null;
  orderMap = null;
  building = false;
  lastLoadedIdsSig = '';
  cacheSig = '';
  cachedReturn = null;
  extraChildrenPool = new Map();
  clearThreadDepthCache();
}
