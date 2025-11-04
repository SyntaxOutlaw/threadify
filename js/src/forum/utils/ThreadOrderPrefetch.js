/**
 * 轻量顺序预取：/discussions/:id/threads-order
 * 提供：
 *  - prefetchThreadOrder(did, { force?: boolean }) -> Promise<void>
 *  - getOrderIndex(did, postId) -> number|undefined
 *  - getDepthPrefetched(did, postId) -> number|undefined
 *  - getParentPrefetched(did, postId) -> number|undefined
 * 并在预取完成后派发 window 事件：'threadify:order-ready'（detail: { discussionId }）
 */

const _cache = new Map(); // did -> { map: Map<postId, {order, depth, parentId}>, ready: Promise, ts: number }
const TTL_MS = 10_000;

export function prefetchThreadOrder(discussionId, opts = {}) {
  const did = String(discussionId);
  const now = Date.now();
  const entry = _cache.get(did);

  if (!opts.force && entry && entry.ready && (now - (entry.ts || 0) < TTL_MS)) {
    return entry.ready; // 命中近期缓存
  }

  const next = entry || { map: new Map(), ready: null, ts: 0 };
  _cache.set(did, next);

  next.ready = app.request({
    method: 'GET',
    url: `${app.forum.attribute('apiUrl')}/discussions/${did}/threads-order?bust=${now}`,
  }).then((res) => {
    const map = new Map();
    (res.order || []).forEach(({ postId, order, depth, parentPostId }) => {
      map.set(Number(postId), {
        order: Number(order),
        depth: Number.isFinite(depth) ? Number(depth) : 0,
        parentId: parentPostId ? Number(parentPostId) : null,
      });
    });
    next.map = map;
    next.ts = Date.now();

    // 通知各处“顺序可用”
    try {
      window.dispatchEvent(new CustomEvent('threadify:order-ready', { detail: { discussionId: Number(did) } }));
    } catch {}
  }).catch((e) => {
    console.warn('[Threadify] order prefetch failed', e);
  });

  return next.ready;
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
