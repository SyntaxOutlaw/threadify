/**
 * 轻量顺序预取：/discussions/:id/threads-order
 * 提供：
 *  - prefetchThreadOrder(did) -> Promise<void>
 *  - getOrderIndex(did, postId) -> number|undefined
 *  - getDepthPrefetched(did, postId) / getParentPrefetched(did, postId)
 *  - isPrefetched(did) -> boolean
 *
 * 行为：
 *  - 预取成功后触发：window.dispatchEvent(new CustomEvent('threadify:orderReady', { detail:Number(did) }))
 *  - 失败也将 ready 置为 true（空映射），避免重复打爆接口
 */

import app from 'flarum/forum/app';

const _cache = new Map(); // did -> { map: Map<postId, {order, depth, parentId}>, ready: Promise|true }

export function prefetchThreadOrder(discussionId) {
  const did = String(discussionId);
  const existing = _cache.get(did);
  if (existing?.ready === true) return Promise.resolve();
  if (existing?.ready && typeof existing.ready.then === 'function') return existing.ready;

  const entry = { map: new Map(), ready: null };
  _cache.set(did, entry);

  entry.ready = app
    .request({
      method: 'GET',
      url: `${app.forum.attribute('apiUrl')}/discussions/${encodeURIComponent(did)}/threads-order`,
    })
    .then((res) => {
      const map = new Map();
      const list = Array.isArray(res?.order) ? res.order : [];
      for (const item of list) {
        if (!item) continue;
        const pid = Number(item.postId);
        const ord = Number(item.order);
        const dep = Number(item.depth);
        const parent = item.parentPostId != null ? Number(item.parentPostId) : null;
        if (!Number.isNaN(pid) && !Number.isNaN(ord)) {
          map.set(pid, {
            order: ord,
            depth: Number.isNaN(dep) ? 0 : dep,
            parentId: parent,
          });
        }
      }
      entry.map = map;
      entry.ready = true;

      // 通知 PostStream 空闲时构建一次顺序映射
      try { window.dispatchEvent(new CustomEvent('threadify:orderReady', { detail: Number(did) })); } catch {}

      // 允许轻量重绘（与 anchorScroll 不同帧）
      try { setTimeout(() => m.redraw(), 0); } catch {}
    })
    .catch((e) => {
      console.warn('[Threadify] order prefetch failed:', e);
      entry.ready = true; // 标记完成以免风暴；map 为空，排序自然回退到本地线程顺序
    });

  return entry.ready;
}

export function getOrderIndex(discussionId, postId) {
  const entry = _cache.get(String(discussionId));
  if (!entry?.map) return undefined;
  const rec = entry.map.get(Number(postId));
  return rec ? rec.order : undefined;
}

export function getDepthPrefetched(discussionId, postId) {
  const entry = _cache.get(String(discussionId));
  if (!entry?.map) return undefined;
  const rec = entry.map.get(Number(postId));
  return rec ? rec.depth : undefined;
}

export function getParentPrefetched(discussionId, postId) {
  const entry = _cache.get(String(discussionId));
  if (!entry?.map) return undefined;
  const rec = entry.map.get(Number(postId));
  return rec ? rec.parentId : undefined;
}

export function isPrefetched(discussionId) {
  const entry = _cache.get(String(discussionId));
  return !!(entry && entry.ready === true);
}
