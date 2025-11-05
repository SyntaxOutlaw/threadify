// js/src/forum/utils/DomReorderMode.js
// 物理重排 .PostStream-item[data-id] —— 仅当“父子同窗”才参与重排；根帖永远参与。
// 不扩大窗口；不跨窗硬搬子帖；留在原地的子帖复用通用缩进逻辑即可。
// 修复：插入前复核 anchor 仍属同容器，避免 NotFoundError；并在无变化时跳过重排。
// 去冗余：不再维护本地缓存，统一复用 ThreadOrderPrefetch.waitOrderMap。

import { extend } from 'flarum/common/extend';
import PostStream from 'flarum/forum/components/PostStream';
import { waitOrderMap } from '../utils/ThreadOrderPrefetch';

const BIG = 10_000_000;

/* ---------------- 基本工具 ---------------- */

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

function getPostElById(container, id) {
  return container?.querySelector?.(`.PostStream-item[data-id="${id}"]`) || null;
}

/* ---------------- 核心逻辑：仅同窗重排 ---------------- */

/**
 * 仅当“根帖”或“父子同窗”才参与重排
 * - 根帖：parentId==null => 永远参与
 * - 子帖：父帖元素存在于当前 container 内 => 参与
 * - 其余：保持原位（不从排序槽里移动）
 */
function computeEligibility(container, posts, orderMap) {
  const eligible = new Set();
  const present = new Set(posts.map((el) => Number(el.dataset.id)));

  for (const el of posts) {
    const id = Number(el.dataset.id);
    const rec = orderMap.get(id);

    // 无记录：保守起见，不参与（避免误搬迁）
    if (!rec) continue;

    if (rec.parentId == null) {
      // 根帖永远参与
      eligible.add(id);
      continue;
    }

    // 父子同窗：父帖在当前 DOM 内
    if (present.has(rec.parentId) || getPostElById(container, rec.parentId)) {
      eligible.add(id);
    }
  }

  return eligible;
}

/**
 * 计算排序键：优先用 orderMap.order；缺失则落到 BIG+id
 */
function orderKey(orderMap, el) {
  const id = Number(el.dataset.id);
  const rec = orderMap.get(id);
  const base = rec ? Number(rec.order) : BIG + id;
  return Number.isFinite(base) ? base : BIG + id;
}

/**
 * 仅重排“可参与”的帖子；不可参与者保持原槽位
 * 实现：把 eligible 作为“可替换槽位”，用按线程顺序排序后的 eligible 列表去覆盖这些槽位，locked 保持不动。
 */
function computeTargetOrder(container, posts, orderMap, eligibleSet) {
  const eligibleList = posts.filter((el) => eligibleSet.has(Number(el.dataset.id)));
  const sortedEligible = eligibleList
    .slice()
    .sort((a, b) => {
      const ka = orderKey(orderMap, a);
      const kb = orderKey(orderMap, b);
      if (ka !== kb) return ka - kb;
      // 次序相等则按 id 保证稳定性
      const ida = Number(a.dataset.id);
      const idb = Number(b.dataset.id);
      return ida - idb;
    });

  // 用排好序的 eligible 覆盖“可参与”的槽位；locked 原样保留
  const target = [];
  let j = 0;
  for (const el of posts) {
    const id = Number(el.dataset.id);
    if (eligibleSet.has(id)) {
      target.push(sortedEligible[j++]);
    } else {
      target.push(el);
    }
  }
  return target;
}

function doReorder(container, currentPosts, orderMap) {
  // 1) 计算可参与集合
  const eligibleSet = computeEligibility(container, currentPosts, orderMap);

  // 2) 生成目标序列（仅对 eligible 槽进行替换）
  const target = computeTargetOrder(container, currentPosts, orderMap, eligibleSet);

  // 3) 若无变化，直接返回
  if (sameOrder(currentPosts, target)) return;

  // 4) 在插入前，重新确认“帖子段”和 anchor，避免参照节点已被窗口化移除
  const rangeNow = findPostsRange(container);
  const anchor = (rangeNow.anchor && rangeNow.anchor.parentNode === container) ? rangeNow.anchor : null;

  // 5) 执行插入：把目标序列按顺序插到“帖子段”之后的第一个兄弟前（anchor==null 等价 append）
  //    这里我们给出最大容错：若过程中 DOM 窗口变化导致 anchor 失效，降级为 append。
  try {
    for (const el of target) {
      if (anchor && anchor.parentNode === container) {
        container.insertBefore(el, anchor);
      } else {
        container.appendChild(el);
      }
    }
  } catch (e) {
    // 某些极端时序仍可能出现 NotFoundError，吞掉并让下一轮 MutationObserver/更新再排
    console.warn('[Threadify] reorder failed (will retry on next tick)', e);
  }
}

/**
 * 读取 Map 后执行一次“仅同窗重排”
 */
function reorderOnce(container, did) {
  return waitOrderMap(did)
    .then((map) => {
      const { posts } = findPostsRange(container);
      if (!posts.length) return;
      doReorder(container, posts, map || new Map());
    })
    .catch((e) => {
      console.warn('[Threadify] order map unavailable', e);
    });
}

/* ---------------- 生命周期挂钩 ---------------- */

export function installDomReorderMode() {
  extend(PostStream.prototype, 'oncreate', function () {
    const did = getDidFromComponent(this);
    const container = getContainer(this);
    if (!did || !container) return;

    // 首次：拉取并按“仅同窗重排”
    reorderOnce(container, did);

    // 监听 Realtime/分页引起的子节点变化，下一帧再按“仅同窗重排”
    let scheduled = false;
    const observer = new MutationObserver((muts) => {
      if (!muts.some((m) => m.type === 'childList')) return;
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        reorderOnce(container, did);
      });
    });

    observer.observe(container, { childList: true });
    this.__threadifyDomObserver = observer;
  });

  extend(PostStream.prototype, 'onupdate', function () {
    const did = getDidFromComponent(this);
    const container = getContainer(this);
    if (!did || !container) return;
    reorderOnce(container, did);
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
