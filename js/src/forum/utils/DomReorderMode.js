// js/src/forum/utils/DomReorderMode.js
// 物理重排 .PostStream-item[data-id]，保持 Scrubber/地址栏楼层号正常。
// ——本版在旧实现基础上改动：
// 1) 统一改用 ThreadOrderPrefetch.waitOrderMap（删除本地缓存与直连请求）。
// 2) 仅当“父子同窗且楼层差 ≤ 50”时才参与重排；>50 的留在原位（仍走通用缩进逻辑）。
// 3) 插入前复核 anchor 是否仍属于容器，避免 NotFoundError；否则降级为 append。

import app from 'flarum/forum/app';
import { extend } from 'flarum/common/extend';
import PostStream from 'flarum/forum/components/PostStream';
import { waitOrderMap, prefetchThreadOrder } from '../utils/ThreadOrderPrefetch';

const BIG = 10_000_000;
const THRESHOLD_NUMBER_GAP = 50;

/** ─── helpers: discussion/container ─── */
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

/** ─── helpers: ids/numbers/parent ─── */
function getPostIdFromEl(el) {
  return Number(el?.dataset?.id);
}

function getPostNumberFromEl(el) {
  // 优先 DOM data-number；缺失则尝试 store
  const dn = el?.dataset?.number;
  if (dn != null) {
    const n = Number(dn);
    if (Number.isFinite(n)) return n;
  }
  const id = getPostIdFromEl(el);
  if (!id) return null;
  try {
    const model = app.store.getById('posts', String(id));
    if (model) {
      if (typeof model.number === 'function') {
        const n = model.number();
        return Number.isFinite(n) ? n : null;
      }
      if (typeof model.attribute === 'function') {
        const n = Number(model.attribute('number'));
        return Number.isFinite(n) ? n : null;
      }
    }
  } catch {}
  return null;
}

function getParentIdFromMap(orderMap, postId) {
  const rec = orderMap.get(Number(postId));
  return rec ? rec.parentId : null;
}

/** ─── helpers: range/same-order ─── */
function sameOrder(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
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

/** ─── 统一的顺序表获取：替代旧 ensureOrderMap，本地不再缓存 ─── */
function ensureOrderMap(did, { force = false } = {}) {
  if (!did) return Promise.resolve(new Map());
  if (force) {
    // 强制刷新一次：先 prefetch(force) 再 wait
    return prefetchThreadOrder(did, { force: true }).then(() => waitOrderMap(did));
  }
  return waitOrderMap(did);
}

/** ─── 仅同窗且父子 ≤ THRESHOLD 的参与重排，其余保留原位 ─── */
function isEligibleForReorder(el, container, orderMap) {
  const selfId = getPostIdFromEl(el);
  if (!selfId) return false;

  const parentId = getParentIdFromMap(orderMap, selfId);
  if (!parentId) return false; // 无父，不参与重排（根帖保留原位）

  const parentEl = container.querySelector(`.PostStream-item[data-id="${parentId}"]`);
  if (!isPostItem(parentEl)) return false; // 父不在同窗

  const selfNo = getPostNumberFromEl(el);
  const parentNo = getPostNumberFromEl(parentEl);
  if (!Number.isFinite(selfNo) || !Number.isFinite(parentNo)) return false;

  return Math.abs(selfNo - parentNo) <= THRESHOLD_NUMBER_GAP;
}

/** ─── 旧 sortPostsByMap 的保留名：改为“合并排序” ───
 * 仅对“可参与”的帖子按线程顺序排序，其它保持原位（留在原地）
 */
function sortPostsByMap(_did, posts, orderMap) {
  const eligible = [];
  const eligibleSet = new Set();

  for (const el of posts) {
    if (isEligibleForReorder(el, document, orderMap)) {
      eligible.push(el);
      eligibleSet.add(el);
    }
  }

  const sortedEligible = eligible.slice().sort((a, b) => {
    const ida = getPostIdFromEl(a);
    const idb = getPostIdFromEl(b);
    const ra = orderMap.get(ida);
    const rb = orderMap.get(idb);
    const oa = ra ? ra.order : BIG + ida;
    const ob = rb ? rb.order : BIG + idb;
    return oa === ob ? ida - idb : oa - ob;
  });

  const merged = [];
  let p = 0;
  for (const el of posts) {
    if (eligibleSet.has(el)) {
      merged.push(sortedEligible[p++]);
    } else {
      merged.push(el);
    }
  }
  return merged;
}

/** ─── 排序与安全插入 ─── */
function doReorder(container, posts, anchor, orderMap) {
  if (!posts.length) return;

  const sorted = sortPostsByMap(null, posts, orderMap);
  if (sameOrder(posts, sorted)) return;

  // 插入前复核 anchor 是否仍在容器中；否则降级为 append
  let target = anchor;
  if (!(target && target.parentNode === container)) {
    target = null;
  }

  for (const el of sorted) {
    // 在循环中也持续校验，避免目标在中途被移除
    if (target && target.parentNode !== container) target = null;
    container.insertBefore(el, target);
  }
}

/** ─── 发现缺漏时强刷一次顺序表再排（保留旧逻辑，但走统一缓存） ─── */
async function reorderDOM(container, did, orderMap) {
  const { posts, anchor } = findPostsRange(container);
  if (!posts.length) return;

  // 缺漏检测：窗口内存在不在 orderMap 的帖子
  const missing = posts.some((el) => !orderMap.has(Number(el.dataset.id)));
  if (missing) {
    const fresh = await ensureOrderMap(did, { force: true });
    // 二次排序（不再递归强刷）
    return doReorder(container, posts, anchor, fresh);
  }

  return doReorder(container, posts, anchor, orderMap);
}

/** ─── 入口：安装 DOM 重排模式 ─── */
export function installDomReorderMode() {
  extend(PostStream.prototype, 'oncreate', function () {
    const did = getDidFromComponent(this);
    const container = getContainer(this);
    if (!did || !container) return;

    // 首次获取统一顺序表并重排
    ensureOrderMap(did).then((map) => reorderDOM(container, did, map));

    // 监听 Realtime/分页引起的子节点变化（仅 childList）
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
