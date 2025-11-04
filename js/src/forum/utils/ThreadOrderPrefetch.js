// js/src/forum/utils/ThreadOrderPrefetch.js
/**
 * 轻量顺序预取：/discussions/:id/threads-order
 * 提供：
 *  - prefetchThreadOrder(did) -> Promise<void>
 *  - getOrderIndex(did, postId) -> number|undefined
 *  - getDepthPrefetched(did, postId) / getParentPrefetched(did, postId)
 *  - isPrefetched(did) -> boolean
 */

import app from 'flarum/forum/app';

const _cache = new Map(); // did -> { map: Map<postId, {order, depth, parentId}>, ready: Promise|true }

/**
 * 预取某讨论的线程顺序（体积很小）
 * 成功后将结果写入内存缓存；失败时保留空 map，避免重复请求风暴。
 * 不触发 m.redraw()，以免打断核心滚动流程。
 */
export function prefetchThreadOrder(discussionId) {
  const did = String(discussionId);

  const existing = _cache.get(did);
  if (existing && existing.ready === true) return Promise.resolve();
  if (existing && existing.ready && typeof existing.ready.then === 'function') return existing.ready;

  const entry = { map: new Map(), ready: null };
  _cache.set(did, entry);

  entry.ready = app
    .request({
      method: 'GET',
      url: `${app.forum.attribute('apiUrl')}/discussions/${encodeURIComponent(did)}/threads-order`,
    })
    .then((res) => {
      const map = new Map();

      // —— 兜底处理：后端若无 order 字段或返回格式异常，使用空数组 —— //
      const list = Array.isArray(res?.order) ? res.order : [];

      // 期望每项形如：{ postId, order, depth, parentPostId }
      for (const item of list) {
        if (!item) continue;
        const pid = Number(item.postId);
        const ord = Number(item.order);
        const dep = Number(item.depth);
        const parent = item.parentPostId != null ? Number(item.parentPostId) : null;

        // 只记录合法的 postId / order
        if (!Number.isNaN(pid) && !Number.isNaN(ord)) {
          map.set(pid, {
            order: ord,
            depth: Number.isNaN(dep) ? 0 : dep,
            parentId: parent,
          });
        }
      }

      entry.map = map;
      entry.ready = true; // ✅ 预取完成
    })
    .catch((e) => {
      console.warn('[Threadify] order prefetch failed:', e);
      // 失败时仍将 ready 置为 true（但 map 为空），防止重复打爆接口
      entry.ready = true;
    });

  return entry.ready;
}

export function getOrderIndex(discussionId, postId) {
  const entry = _cache.get(String(discussionId));
  if (!entry || !entry.map) return undefined;
  const rec = entry.map.get(Number(postId));
  return rec ? rec.order : undefined;
}

export function getDepthPrefetched(discussionId, postId) {
  const entry = _cache.get(String(discussionId));
  if (!entry || !entry.map) return undefined;
  const rec = entry.map.get(Number(postId));
  return rec ? rec.depth : undefined;
}

export function getParentPrefetched(discussionId, postId) {
  const entry = _cache.get(String(discussionId));
  if (!entry || !entry.map) return undefined;
  const rec = entry.map.get(Number(postId));
  return rec ? rec.parentId : undefined;
}

export function isPrefetched(discussionId) {
  const entry = _cache.get(String(discussionId));
  return !!(entry && entry.ready === true);
}
