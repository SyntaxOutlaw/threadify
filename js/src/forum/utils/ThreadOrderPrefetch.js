/**
 * 轻量顺序预取：/discussions/:id/threads-order
 * 提供：
 *  - prefetchThreadOrder(did) -> Promise<void>
 *  - getOrderIndex(did, postId) -> number|undefined
 *  - getDepthPrefetched(did, postId) / getParentPrefetched(did, postId)
 */

const _cache = new Map(); // did -> { map: Map<postId, {order, depth, parentId}>, ready: Promise }

export function prefetchThreadOrder(discussionId) {
  const did = String(discussionId);
  const exist = _cache.get(did);
  if (exist && exist.ready) return exist.ready;

  const entry = exist || { map: new Map(), ready: null };
  _cache.set(did, entry);

  entry.ready = app.request({
    method: 'GET',
    url: `${app.forum.attribute('apiUrl')}/discussions/${did}/threads-order`,
    // 浏览器自动处理 ETag/304；我们不必手动缓存头
  }).then((res) => {
    const map = new Map();
    (res.order || []).forEach(({ postId, order, depth, parentPostId }) => {
      map.set(Number(postId), {
        order: Number(order),
        depth: Number(depth),
        parentId: parentPostId != null ? Number(parentPostId) : null
      });
    });
    entry.map = map;
    // 预取完成后，visiblePosts 的比较器会立刻按映射重排（通常无跳动）
    m.redraw();
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
