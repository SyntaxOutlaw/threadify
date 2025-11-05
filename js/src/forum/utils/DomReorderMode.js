// 物理重排 .PostStream-item[data-id]，保持 Scrubber/地址栏楼层号正常。
// 只在“同一窗口（父子都已加载到当前 .PostStream）”且“父子楼层差 ≤ 50”时参与重排。
// 统一复用 ThreadOrderPrefetch.waitOrderMap，移除本地缓存。
// 修复：insertBefore 的参照锚点若已不在容器内，降级为 append，并避免在无变化时重排。

import app from 'flarum/forum/app';
import { extend } from 'flarum/common/extend';
import PostStream from 'flarum/forum/components/PostStream';
import { waitOrderMap } from '../utils/ThreadOrderPrefetch';

const THRESHOLD_NUMBER_GAP = 50;
const BIG = 10_000_000;

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

function getPostIdFromEl(el) {
  return Number(el?.dataset?.id);
}

function getPostNumberFromEl(el) {
  // 优先 DOM 上的 data-number；缺失则从 store 读取
  const dn = el?.dataset?.number;
  if (dn != null) {
    const n = Number(dn);
    if (Number.isFinite(n)) return n;
  }
  const id = getPostIdFromEl(el);
  if (!id) return null;
  try {
    const model = app.store.getById('posts', String(id));
    if (model && typeof model.number === 'function') {
      const n = model.number();
      return Number.isFinite(n) ? n : null;
    }
    if (model && typeof model.attribute === 'function') {
      const n = Number(model.attribute('number'));
      return Number.isFinite(n) ? n : null;
    }
  } catch {}
  return null;
}

function getParentIdFromMap(orderMap, postId) {
  const rec = orderMap.get(Number(postId));
  return rec ? rec.parentId : null;
}

function isEligibleForReorder(el, container, orderMap) {
  // 条件：1) 有 parent；2) 父节点也在当前容器（同窗）；3) 楼层差 ≤ 阈值
  const selfId = getPostIdFromEl(el);
  const parentId = getParentIdFromMap(orderMap, selfId);
  if (!parentId) return false;

  const parentEl = container.querySelector(`.PostStream-item[data-id="${parentId}"]`);
  if (!isPostItem(parentEl)) return false; // 不在同窗

  const selfNo = getPostNumberFromEl(el);
  const parentNo = getPostNumberFromEl(parentEl);
  if (!Number.isFinite(selfNo) || !Number.isFinite(parentNo)) return false;

  return Math.abs(selfNo - parentNo) <= THRESHOLD_NUMBER_GAP;
}

function buildMergedOrder(container, posts, orderMap) {
  // 仅对“可参与”的帖子排序，其它保持原位
  const eligible = [];
  const eligibleSet = new Set();

  for (const el of posts) {
    if (isEligibleForReorder(el, container, orderMap)) {
      eligible.push(el);
      eligibleSet.add(el);
    }
  }

  // 按线程顺序（order）排“可参与”的子集
  const sortedEligible = eligible.slice().sort((a, b) => {
    const ia = getPostIdFromEl(a);
    const ib = getPostIdFromEl(b);
    const ra = orderMap.get(ia);
    const rb = orderMap.get(ib);
    const oa = ra ? ra.order : BIG + ia;
    const ob = rb ? rb.order : BIG + ib;
    return oa === ob ? ia - ib : oa - ob;
  });

  // 合并：只替换“可参与”的槽位，不动其它
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

function doReorder(container, posts, anchor, orderMap) {
  if (!posts.length) return;

  const merged = buildMergedOrder(container, posts, orderMap);
  if (sameOrder(posts, merged)) return;

  // 插入前复核 anchor 是否仍在容器中；否则降级为 append
  let target = anchor;
  if (!(target && target.parentNode === container)) {
    target = null;
  }

  for (const el of merged) {
    // 若在循环中容器发生变化，持续复核
    if (target && target.parentNode !== container) target = null;
    container.insertBefore(el, target);
  }
}

async function reorderDOM(container, did) {
  const { posts, anchor } = findPostsRange(container);
  if (!posts.length) return;

  const orderMap = await waitOrderMap(did);
  if (!(orderMap && orderMap.size >= 0)) return;

  doReorder(container, posts, anchor, orderMap);
}

export function installDomReorderMode() {
  extend(PostStream.prototype, 'oncreate', function () {
    const did = getDidFromComponent(this);
    const container = getContainer(this);
    if (!did || !container) return;

    // 首次：拉取并重排
    reorderDOM(container, did);

    // 监听 Realtime/分页引起的子节点变化
    let scheduled = false;
    const observer = new MutationObserver((muts) => {
      if (!muts.some((m) => m.type === 'childList')) return;
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        reorderDOM(container, did);
      });
    });

    observer.observe(container, { childList: true });
    this.__threadifyDomObserver = observer;
  });

  extend(PostStream.prototype, 'onupdate', function () {
    const did = getDidFromComponent(this);
    const container = getContainer(this);
    if (!did || !container) return;
    reorderDOM(container, did);
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
