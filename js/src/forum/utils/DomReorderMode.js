// js/src/forum/utils/DomReorderMode.js
// 物理重排 .PostStream-item[data-id]，保持 Scrubber/地址栏楼层号正常。
// 监听分页与 Realtime 变化，在下一帧按 /threads-order 顺序 insertBefore。
// 若发现新帖不在缓存顺序表中，会强制刷新一次顺序表再排序。

import { extend } from 'flarum/common/extend';
import PostStream from 'flarum/forum/components/PostStream';

const BIG = 10_000_000;
const TTL_MS = 10_000; // 顺序表缓存 10s

function getDidFromComponent(ps) {
  try {
    return ps?.stream?.discussion?.id?.() ?? null;
  } catch {
    return null;
  }
}

function getContainer(ps) {
  // 1) 根就是 .PostStream
  if (ps?.element && ps.element.classList && ps.element.classList.contains('PostStream')) {
    return ps.element;
  }
  // 2) 向下找
  const found = ps?.element?.querySelector?.('.PostStream');
  if (found) return found;
  // 3) 兜底：全局找（极端情况下）
  return document.querySelector('.PostStream') || null;
}

function isPostItem(el) {
  return el && el.nodeType === 1 && el.matches('.PostStream-item[data-id]');
}

function collectChildren(container) {
  return Array.from(container?.children || []);
}

// ---- 轻量顺序缓存：did -> { ts, map (Map<postId,{order,depth,parentId}>), promise }
const orderCache = new Map();

function ensureOrderMap(did, { force = false } = {}) {
  const key = String(did);
  const now = Date.now();
  const cached = orderCache.get(key);

  if (!force && cached) {
    // 命中有效缓存
    if (cached.map && now - (cached.ts || 0) < TTL_MS) {
      return Promise.resolve(cached.map);
    }
    // 已有在飞中的请求
    if (cached.promise) return cached.promise.then((h) => h.map);
  }

  const holder = cached || { ts: 0, map: null, promise: null };
  orderCache.set(key, holder);

  holder.promise = app
    .request({
      method: 'GET',
      url: `${app.forum.attribute('apiUrl')}/discussions/${did}/threads-order?bust=${now}`,
    })
    .then((res) => {
      const map = new Map();
      (res.order || []).forEach(({ postId, order, depth, parentPostId }) => {
        map.set(Number(postId), {
          order: Number(order),
          depth: Number.isFinite(depth) ? Number(depth) : 0,
          parentId: parentPostId ? Number(parentPostId) : null,
        });
      });
      holder.map = map;
      holder.ts = Date.now();
      return holder;
    })
    .catch((e) => {
      console.warn('[Threadify] threads-order fetch failed', e);
      // 失败给空表，至少不阻塞渲染
      holder.map = holder.map || new Map();
      holder.ts = Date.now();
      return holder;
    });

  return holder.promise.then((h) => h.map);
}

function sortPostsByMap(did, posts, orderMap) {
  const arr = posts.slice();
  arr.sort((a, b) => {
    const ida = Number(a.dataset.id);
    const idb = Number(b.dataset.id);
    const ra = orderMap.get(ida);
    const rb = orderMap.get(idb);
    const oa = ra ? ra.order : BIG + ida;
    const ob = rb ? rb.order : BIG + idb;
    return oa === ob ? ida - idb : oa - ob;
  });
  return arr;
}

function sameOrder(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function signature(nodes) {
  try {
    return nodes.map((n) => n.dataset.id).join(',');
  } catch {
    return '';
  }
}

function findPostsRange(container) {
  const kids = collectChildren(container);
  if (!kids.length) return { posts: [], left: -1, right: -1, anchor: null };

  let L = kids.findIndex(isPostItem);
  if (L < 0) return { posts: [], left: -1, right: -1, anchor: kids[0] || null };

  let R = kids.length - 1 - [...kids].reverse().findIndex(isPostItem);
  if (R < L) R = L;

  const posts = kids.slice(L, R + 1).filter(isPostItem);
  const anchor = kids[R + 1] || null; // 在“帖子段”之后的第一个兄弟之前插入
  return { posts, left: L, right: R, anchor };
}

// 如果发现有帖子不在顺序表中，强刷一次再排（只强刷一遍防止抖动）
async function reorderDOM(container, did, orderMap) {
  const { posts, anchor } = findPostsRange(container);
  if (!posts.length) return;

  // 缺漏检测
  const missing = posts.some((el) => !orderMap.has(Number(el.dataset.id)));
  if (missing) {
    const fresh = await ensureOrderMap(did, { force: true });
    // 二次排序（不再递归强刷）
    return doReorder(container, posts, anchor, fresh);
  }

  return doReorder(container, posts, anchor, orderMap);
}

function doReorder(container, posts, anchor, orderMap) {
  const sorted = sortPostsByMap(null, posts, orderMap);
  if (sameOrder(posts, sorted)) return;

  for (const el of sorted) {
    container.insertBefore(el, anchor);
  }
}

export function installDomReorderMode() {
  extend(PostStream.prototype, 'oncreate', function () {
    const did = getDidFromComponent(this);
    const container = getContainer(this);
    if (!did || !container) return;

    // 首次：拉取并重排
    ensureOrderMap(did).then((map) => reorderDOM(container, did, map));

    // 监听 Realtime/分页引起的子节点变化
    let scheduled = false;
    const observer = new MutationObserver((muts) => {
      if (!muts.some((m) => m.type === 'childList')) return;
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        ensureOrderMap(did).then((map) => reorderDOM(container, did, map));
      });
    });

    observer.observe(container, { childList: true });
    this.__threadifyDomObserver = observer;
  });

  extend(PostStream.prototype, 'onupdate', function () {
    const did = getDidFromComponent(this);
    const container = getContainer(this);
    if (!did || !container) return;
    ensureOrderMap(did).then((map) => reorderDOM(container, did, map));
  });

  extend(PostStream.prototype, 'onremove', function () {
    if (this.__threadifyDomObserver) {
      try {
        this.__threadifyDomObserver.disconnect();
      } catch {}
      this.__threadifyDomObserver = null;
    }
  });
}
