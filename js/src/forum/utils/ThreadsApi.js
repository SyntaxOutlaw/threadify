/**
 * threads-order API 轻量层
 * - 负责预取并缓存：Map<postId, { order, depth, parentId }>
 * - 暴露读取与监听工具
 */

const _cache = new Map(); // did -> { ready: Promise<void>, map: Map<number,{order,depth,parentId}> }

export function prefetchThreadsOrder(discussionId) {
  const did = Number(discussionId);
  if (!did) return Promise.resolve();

  const hit = _cache.get(did);
  if (hit && hit.ready) return hit.ready;

  const entry = { ready: null, map: new Map() };
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

    // 通知前端其它模块（可选）
    try {
      window.dispatchEvent(new CustomEvent('threadify:order-ready', { detail: { discussionId: did } }));
    } catch (e) {}
  }).catch((e) => {
    console.warn('[Threadify] threads-order prefetch failed', e);
  });

  return entry.ready;
}

export function getOrderRecord(discussionId, postId) {
  const entry = _cache.get(Number(discussionId));
  if (!entry) return undefined;
  return entry.map.get(Number(postId));
}

export function getPrefetchedDepth(discussionId, postId) {
  const rec = getOrderRecord(discussionId, postId);
  return rec ? rec.depth : undefined;
}

export function hasOrderFor(discussionId) {
  const entry = _cache.get(Number(discussionId));
  return !!(entry && entry.map && entry.map.size);
}

// 供 SimplifiedThreadDepth 使用：把预取到的元数据回传给“加类名”逻辑
export function getPostThreadMetadata(post) {
  if (!post) return null;
  const discussion = post.discussion && post.discussion();
  const did = discussion && discussion.id && discussion.id();
  if (!did) return null;

  const rec = getOrderRecord(did, post.id());
  if (!rec) return null;

  // 注意：rootPostId/descendantCount 这类聚合值由服务端负责；此处仅返回前端需要的 depth/parent
  return {
    depth: rec.depth,
    threadPath: null,
    isRoot: !rec.parentId,
    childCount: 0,
    descendantCount: 0,
    rootPostId: null,
  };
}
