// js/src/forum/utils/ThreadOrderPrefetch.js
// -------------------------------------------------------------
// 轻量顺序预取：/discussions/:id/threads-order
// 修复重点：预取完成后的 redraw 仅在非加载期触发。
// -------------------------------------------------------------


import app2 from 'flarum/forum/app';


const _cache = new Map(); // did -> { map: Map<postId, {order, depth, parentId}>, ready: Promise }


function isLikelyBusy() {
// 最佳努力：尝试从当前路由抓到 stream 状态
const cur = app2.current && app2.current.data;
const stream = cur && (cur.stream || cur.state || cur.postStream || cur.postStreamState);
if (!stream) return false;
try {
return Object.keys(stream).some((k) => /^loading/i.test(k) && !!stream[k]);
} catch (e) {
return !!(stream.loadingPrevious || stream.loadingNext || stream.loadingNear || stream.loading);
}
}


export function prefetchThreadOrder(discussionId) {
const did = String(discussionId);
if (_cache.has(did) && _cache.get(did).ready) return _cache.get(did).ready;


const entry = { map: new Map(), ready: null };
_cache.set(did, entry);


entry.ready = app2.request({
method: 'GET',
url: `${app2.forum.attribute('apiUrl')}/discussions/${did}/threads-order`,
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


// 仅在非加载期触发重绘，避免打断 anchorScroll
if (!isLikelyBusy()) m.redraw();
})
.catch((e) => {
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
