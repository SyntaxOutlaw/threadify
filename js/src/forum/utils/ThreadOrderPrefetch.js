/**
 * 轻量顺序预取：/discussions/:id/threads-order
 * 提供：
 *  - prefetchThreadOrder(did) -> Promise<void>
 *  - getOrderIndex(did, postId) -> number|undefined
 *  - getDepthPrefetched(did, postId) / getParentPrefetched(did, postId)
 *  - isPrefetched(did) -> boolean
 */

const _cache = new Map(); // did -> { map: Map<postId, {order, depth, parentId}>, ready: Promise|true }

export function prefetchThreadOrder(discussionId) {
  const did = String(discussionId);
  const existing = _cache.get(did);
  if (existing && existing.ready === true) return Promise.resolve();
  if (existing && existing.ready && typeof existing.ready.then === 'function') return existing.ready;

  const entry = { map: new Map(), ready: null };
  _cache.set(did, entry);

  entry.ready = app.request({
    method: 'GET',
    url: `${app.forum.attribute('apiUrl')}/discussions/${did}/threads-order`,
  })
    .then((res) => {
      const map = new Map();
      (res.order || []).forEach(({ postId, order, depth, parentPostId }) => {
        map.set(Number(postId), {
          order: Number(order),
          depth: Number(depth),
          parentId: parentPostId ? Number(parentPostId) : null,
        });
      });
      entry.map = map;
      entry.ready = true;           // ✅ 预取完成标记
      // 不再 m.redraw() —— 避免打断核心滚动加载流程
    })
    .catch((e) => {
      console.warn('[Threadify] order prefetch failed', e);
      // 失败时仍保留空 map，避免重复请求风暴
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
  return !!(entry && entry.ready === true && entry.map && entry.map.size >= 0);
}
