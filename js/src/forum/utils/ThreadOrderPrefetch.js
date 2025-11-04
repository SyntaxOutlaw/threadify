// js/src/forum/utils/ThreadOrderPrefetch.js

/**
 * 轻量顺序预取：/discussions/:id/threads-order
 * 提供：
 *  - prefetchThreadOrder(did) -> Promise<void>
 *  - getOrderIndex(did, postId) -> number|undefined
 *  - getDepthPrefetched(did, postId) -> number|undefined
 *  - getParentPrefetched(did, postId) -> number|undefined
 * 并在预取完成后派发 window 事件：'threadify:order-ready'（detail: { discussionId }）
 */

const _cache = new Map(); // did -> { map: Map<postId, {order, depth, parentId}>, ready: Promise }

export function prefetchThreadOrder(discussionId) {
  const did = String(discussionId);
  if (_cache.has(did) && _cache.get(did).ready) return _cache.get(did).ready;

  const entry = { map: new Map(), ready: null };
  _cache.set(did, entry);

  entry.ready = app.request({
    method: 'GET',
    url: `${app.forum.attribute('apiUrl')}/discussions/${did}/threads-order`,
  }).then((res) => {
    const map = new Map();
    (res.order || []).forEach(({ postId, order, depth, parentPostId }) => {
      map.set(Number(postId), {
        order: Number(order),
        depth: Number.isFinite(depth) ? Number(depth) : 0,
        parentId: parentPostId ? Number(parentPostId) : null,
      });
    });
    entry.map = map;

    // 通知各处“顺序可用”
    try {
      window.dispatchEvent(new CustomEvent('threadify:order-ready', { detail: { discussionId: Number(did) } }));
    } catch (e) { /* older browsers */ }

  }).catch((e) => {
    console.warn('[Threadify] order prefetch failed', e);
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

