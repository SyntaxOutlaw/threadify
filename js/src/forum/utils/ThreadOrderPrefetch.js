/**
 * 轻量顺序预取：/discussions/:id/threads-order
 * 提供：
 *  - prefetchThreadOrder(did) -> Promise<void>
 *  - getOrderIndex(did, postId) -> number|undefined
 *  - getDepthPrefetched(did, postId) / getParentPrefetched(did, postId)
 *  - isPrefetched(did) -> boolean
 *  - collectChildrenIdsForParents(did, parentIds, limitPerParent=8, pick='latest', maxTotal=40)
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

      try { window.dispatchEvent(new CustomEvent('threadify:orderReady', { detail: Number(did) })); } catch {}
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

/**
 * 从预取映射中为一组父帖收集子帖 ID（按 order 排序）
 * @param {number|string} discussionId
 * @param {Iterable<number|string>} parentIds
 * @param {number} limitPerParent 每个父帖最多取多少子帖
 * @param {'latest'|'earliest'} pick 选最新还是最早的子帖
 * @param {number} maxTotal 本次最多返回多少条，防止一次性过大
 * @returns {number[]} 子帖 ID（去重后）
 */
export function collectChildrenIdsForParents(discussionId, parentIds, limitPerParent = 8, pick = 'latest', maxTotal = 40) {
  const entry = _cache.get(String(discussionId));
  if (!entry?.map || !parentIds) return [];

  const pset = new Set([...parentIds].map((x) => Number(x)));
  if (pset.size === 0) return [];

  // 先把所有候选子帖取出来：Map<parentId, Array<{postId, order}>>
  const buckets = new Map();
  for (const [postId, rec] of entry.map.entries()) {
    const pid = rec?.parentId;
    if (!pid || !pset.has(pid)) continue;
    let arr = buckets.get(pid);
    if (!arr) { arr = []; buckets.set(pid, arr); }
    arr.push({ postId: Number(postId), order: rec.order || 0 });
  }

  // 对每个父帖的孩子按 order 排序后截取
  const out = [];
  for (const [pid, arr] of buckets.entries()) {
    arr.sort((a, b) => a.order - b.order);
    const picked = pick === 'earliest' ? arr.slice(0, limitPerParent) : arr.slice(-limitPerParent);
    for (const it of picked) out.push(it.postId);
    if (out.length >= maxTotal) break;
  }

  // 去重裁剪
  return Array.from(new Set(out)).slice(0, maxTotal);
}
