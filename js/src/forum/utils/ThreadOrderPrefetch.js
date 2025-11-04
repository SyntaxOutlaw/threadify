/**
 * 轻量顺序预取：/discussions/:id/threads-order
 *
 * 暴露：
 *  - prefetchThreadOrder(did, { force?: boolean }) -> Promise<void>
 *  - getOrderIndex(did, postId) -> number|undefined
 *  - getDepthPrefetched(did, postId) -> number|undefined
 *  - getParentPrefetched(did, postId) -> number|undefined
 *  - getCachedOrderMap(did) -> Map|undefined  （新增：同步读缓存给其它模块复用）
 *  - waitOrderMap(did) -> Promise<Map>        （新增：等待就绪并拿 Map）
 *  - hasFreshOrder(did) -> boolean            （新增：是否在 TTL 内）
 *  - invalidateThreadOrder(did)               （新增：使某讨论缓存失效）
 *  - clearAllThreadOrderCache()               （新增：清空所有缓存）
 *
 * 事件：
 *  - window.dispatchEvent(new CustomEvent('threadify:order-ready', { detail: { discussionId } }))
 */

const _cache = new Map(); // did -> { map: Map<postId,Rec>, inflight: Promise<void>|null, ts: number }
const TTL_MS = 10_000;
const EVT_READY = 'threadify:order-ready';

/**
 * @param {number|string} discussionId
 * @param {{force?: boolean}} opts
 */
export function prefetchThreadOrder(discussionId, opts = {}) {
  const did = _coerceDid(discussionId);
  if (!did) return Promise.resolve();

  const now = Date.now();
  const entry = _cache.get(did) || { map: new Map(), inflight: null, ts: 0 };
  _cache.set(did, entry);

  // 命中新鲜缓存：直接复用最后一次 inflight（若有），否则返回已完成的 resolved
  if (!opts.force && (now - entry.ts) < TTL_MS) {
    return entry.inflight || Promise.resolve();
  }

  // 已有请求在路上，且不强制：直接复用
  if (entry.inflight && !opts.force) return entry.inflight;

  // 发起新请求
  const bust = now; // 避免中间层缓存
  entry.inflight = app.request({
    method: 'GET',
    url: `${app.forum.attribute('apiUrl')}/discussions/${did}/threads-order?bust=${bust}`,
  }).then((res) => {
    const map = new Map();
    (res && res.order ? res.order : []).forEach(({ postId, order, depth, parentPostId }) => {
      postId = Number(postId);
      map.set(postId, {
        order: Number(order),
        depth: Number.isFinite(depth) ? Number(depth) : 0,
        parentId: parentPostId ? Number(parentPostId) : null,
      });
    });

    entry.map = map;
    entry.ts = Date.now();

    // 广播就绪
    try {
      window.dispatchEvent(new CustomEvent(EVT_READY, { detail: { discussionId: Number(did) } }));
    } catch {}
  }).catch((e) => {
    console.warn('[Threadify] order prefetch failed', e);
  }).finally(() => {
    // 标记无在途请求
    // 注意：保留 entry.map 与 entry.ts
    entry.inflight = null;
  });

  return entry.inflight;
}

/**
 * @param {number|string} discussionId
 * @param {number|string} postId
 * @returns {number|undefined}
 */
export function getOrderIndex(discussionId, postId) {
  const map = getCachedOrderMap(discussionId);
  const rec = map && map.get(Number(postId));
  return rec ? rec.order : undefined;
}

/**
 * @param {number|string} discussionId
 * @param {number|string} postId
 * @returns {number|undefined}
 */
export function getDepthPrefetched(discussionId, postId) {
  const map = getCachedOrderMap(discussionId);
  const rec = map && map.get(Number(postId));
  return rec ? rec.depth : undefined;
}

/**
 * @param {number|string} discussionId
 * @param {number|string} postId
 * @returns {number|undefined}
 */
export function getParentPrefetched(discussionId, postId) {
  const map = getCachedOrderMap(discussionId);
  const rec = map && map.get(Number(postId));
  return rec ? rec.parentId : undefined;
}

/**
 * 同步读取缓存 Map（若不存在返回 undefined）
 * @param {number|string} discussionId
 * @returns {Map<number,{order:number,depth:number,parentId:number|null}>|undefined}
 */
export function getCachedOrderMap(discussionId) {
  const did = _coerceDid(discussionId);
  if (!did) return undefined;
  const entry = _cache.get(did);
  return entry ? entry.map : undefined;
}

/**
 * 等待 Map 可用并返回
 * 若缓存新鲜则立即 resolve；否则等待在途请求或触发一次预取
 * @param {number|string} discussionId
 * @returns {Promise<Map<number,{order:number,depth:number,parentId:number|null}>>}
 */
export function waitOrderMap(discussionId) {
  const did = _coerceDid(discussionId);
  if (!did) return Promise.resolve(new Map());

  const now = Date.now();
  const entry = _cache.get(did) || { map: new Map(), inflight: null, ts: 0 };
  _cache.set(did, entry);

  if ((now - entry.ts) < TTL_MS && entry.map && entry.map.size >= 0) {
    return Promise.resolve(entry.map);
  }

  const p = entry.inflight || prefetchThreadOrder(did);
  return p.then(() => getCachedOrderMap(did) || new Map());
}

/**
 * 缓存是否在 TTL 内新鲜
 * @param {number|string} discussionId
 */
export function hasFreshOrder(discussionId) {
  const did = _coerceDid(discussionId);
  if (!did) return false;
  const entry = _cache.get(did);
  if (!entry) return false;
  return (Date.now() - (entry.ts || 0)) < TTL_MS;
}

/**
 * 使单个讨论的缓存失效（下一次 wait/prefetch 会重新拉取）
 * @param {number|string} discussionId
 */
export function invalidateThreadOrder(discussionId) {
  const did = _coerceDid(discussionId);
  if (!did) return;
  const entry = _cache.get(did);
  if (entry) entry.ts = 0;
}

/** 清空所有讨论的线程顺序缓存 */
export function clearAllThreadOrderCache() {
  _cache.clear();
}

/* ---------------- 内部工具 ---------------- */

function _coerceDid(discussionId) {
  if (discussionId == null) return null;
  const n = Number(discussionId);
  return Number.isFinite(n) && n > 0 ? String(n) : null;
}
