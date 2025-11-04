/**
 * 轻量顺序预取：/discussions/:id/threads-order
 * 提供：
 *  - prefetchThreadOrder(did) -> Promise<void>
 *  - getOrderIndex(did, postId) -> number|undefined
 *  - getDepth(did, postId) / getParentId(did, postId)
 *
 * 最小修复：避免在分页加载期触发强制重绘，降低与 anchorScroll 的竞争。
 */

const _cache = new Map(); // did -> { map: Map<postId, {order, depth, parentId}>, ready: Promise }

// 尝试检测当前页面的 PostStreamState 是否处于加载中
function isBusy() {
  const cur = app.current && app.current.data;
  const state = cur && cur.stream;
  return !!(state && Object.keys(state).some((k) => /^loading/i.test(k) && state[k]));
}

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
        depth: Number(depth),
        parentId: parentPostId ? Number(parentPostId) : null,
      });
    });
    entry.map = map;

    // 预取完成后：如果不在加载，就立即重绘；否则稍后再试一次
    if (!isBusy()) {
      try { m.redraw(); } catch (e) {}
    } else {
      setTimeout(() => { if (!isBusy()) { try { m.redraw(); } catch (e) {} } }, 100);
    }
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
