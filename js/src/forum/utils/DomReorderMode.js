// 物理重排 .PostStream-item[data-id]，保持 Scrubber/地址栏楼层号正常。
// —— 在旧实现基础上的修订 ——
// 1) 统一使用 ThreadOrderPrefetch.waitOrderMap（去掉本地缓存与直连请求）。
// 2) 仅当“父子同窗且楼层差 ≤ 50”时让「子帖」参与重排；「根帖」始终参与重排。
// 3) 插入前复核 anchor 是否仍在容器中，避免 NotFoundError；否则降级为 append。
// 4) sortPostsByMap 必须用当前容器（不是 document）做“同窗”判定。

import app from 'flarum/forum/app';
import { extend } from 'flarum/common/extend';
import PostStream from 'flarum/forum/components/PostStream';
import { waitOrderMap, prefetchThreadOrder } from '../utils/ThreadOrderPrefetch';

const BIG = 10_000_000;
const THRESHOLD_NUMBER_GAP = 50;

/** ---- helpers: discussion/container ---- */
function getDidFromComponent(ps) {
  try {
    return ps?.stream?.discussion?.id?.() ?? null;
  } catch {
    return null;
  }
}

function getContainer(ps) {
  if (ps?.element && ps.element.classList && ps.element.classList.contains('PostStream')) {
    return ps.element;
  }
  const found = ps?.element?.querySelector?.('.PostStream');
  if (found) return found;
  return document.querySelector('.PostStream') || null;
}

function isPostItem(el) {
  return el && el.nodeType === 1 && el.matches('.PostStream-item[data-id]');
}

function collectChildren(container) {
  return Array.from(container?.children || []);
}

/** ---- helpers: ids/numbers/parent ---- */
function getPostIdFromEl(el) {
  return Number(el?.dataset?.id);
}

function getPostNumberFromEl(el) {
  // 优先 DOM data-number；缺失则尝试从 store 读取
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

function getParentIdFromMapOrStore(orderMap, postId) {
  const rec = orderMap.get(Number(postId));
  if (rec) return rec.parentId; // null 表示根；number 表示有父
  // 兜底：用 store 里的 parent_id
  try {
    const model = app.store.getById('posts', String(postId));
    if (model && typeof model.attribute === 'function') {
      const pid = model.attribute('parent_id');
      return pid == null ? null : Number(pid);
    }
  } catch {}
  return undefined; // 未知（既没 map，也没拿到 attribute）
}

/** ---- helpers: range/same-order ---- */
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

/** ---- 统一顺序表（替代旧 ensureOrderMap，本地不再缓存） ---- */
function ensureOrderMap(did, { force = false } = {}) {
  if (!did) return Promise.resolve(new Map());
  if (force) {
    // 强制刷新：先 prefetch(force) 再 wait
    return prefetchThreadOrder(did, { force: true }).then(() => waitOrderMap(did));
  }
  return waitOrderMap(did);
}

/** ---- 参与重排判定 ----
 *  规则：
 *   - 根帖（parentId === null）始终参与重排（让子树能贴近）。
 *   - 有父帖：仅当「父在同窗」且「楼层差 ≤ THRESHOLD」才参与；否则保留原位。
 *   - 未知 parent（undefined）→ 保守：不参与（保持原位）。
 */
function isEligibleForReorder(container, orderMap, el) {
  const selfId = getPostIdFromEl(el);
  if (!selfId) return false;

  const parentId = getParentIdFromMapOrStore(orderMap, selfId);

  // 根帖：参与排序（关键修正）
  if (parentId === null) return true;

  // 未知：保持原位
  if (parentId === undefined) return false;

  // 有父：判同窗与 gap
  const parentEl = container.querySelector(`.PostStream-item[data-id="${parentId}"]`);
  if (!isPostItem(parentEl)) return false;

  const selfNo = getPostNumberFromEl(el);
  const parentNo = getPostNumberFromEl(parentEl);
  if (!Number.isFinite(selfNo) || !Number.isFinite(parentNo)) return false;

  return Math.abs(selfNo - parentNo) <= THRESHOLD_NUMBER_GAP;
}

/** ---- sortPostsByMap（保留旧函数名/职责） ----
 *  策略：仅对“可参与”的帖子按线程顺序排序，其它保持原位。
 *  注意：这里必须使用「当前容器」做同窗判定，不能用 document。
 */
function sortPostsByMap(container, posts, orderMap) {
  const eligible = [];
  const eligibleSet = new Set();

  for (const el of posts) {
    if (isEligibleForReorder(container, orderMap, el)) {
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
      merged.push(el); // >50/父不在窗/未知parent 的，留在原位（你现有缩进样式照常）
    }
  }
  return merged;
}

/** ---- 排序与安全插入 ---- */
function doReorder(container, posts, anchor, orderMap) {
  if (!posts.length) return;

  const sorted = sortPostsByMap(container, posts, orderMap);
  if (sameOrder(posts, sorted)) return;

  // 插入前复核 anchor 是否仍在容器；否则降级为 append
  let target = anchor;
  if (!(target && target.parentNode === container)) {
    target = null;
  }

  for (const el of sorted) {
    if (target && target.parentNode !== container) target = null;
    container.insertBefore(el, target);
  }
}

/** ---- 发现缺漏时强刷一次顺序表再排（沿用旧逻辑，但走统一缓存） ---- */
async function reorderDOM(container, did, orderMap) {
  const { posts, anchor } = findPostsRange(container);
  if (!posts.length) return;

  const missing = posts.some((el) => !orderMap.has(Number(el.dataset.id)));
  if (missing) {
    const fresh = await ensureOrderMap(did, { force: true });
    return doReorder(container, posts, anchor, fresh);
  }

  return doReorder(container, posts, anchor, orderMap);
}

/** ---- 安装 DOM 重排模式 ---- */
export function installDomReorderMode() {
  extend(PostStream.prototype, 'oncreate', function () {
    const did = getDidFromComponent(this);
    const container = getContainer(this);
    if (!did || !container) return;

    ensureOrderMap(did).then((map) => reorderDOM(container, did, map));

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
