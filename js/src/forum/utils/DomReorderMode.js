// js/src/forum/utils/DomReorderMode.js
// Threadify DOM Reorder — “锚定编织（anchored weave）”
// 只在当前窗口(.PostStream-item[data-id])内工作，不修改 PostStreamState/窗口大小。
// 规则：
// - “可移动评论”：根帖或“父子同窗”的 comment（在 orderMap 里且父在窗或无父）。
// - “固定节点”：事件帖（不在 orderMap）以及“父不在窗的子帖”（在 orderMap 但父不在窗）。
// - 目标序列 = 以 /threads-order 的 order 为骨架；
//   固定节点根据“邻近已知顺序”的插值得到 baseOrder，仅用于让可移动评论跨越它们；
// - 只移动“可移动评论”，固定节点不搬家；自右向左按目标序列插入，避免竞态。
// - 首次加载若 URL 带 near/#p，则在首轮重排后轻微回中该楼。

import { extend } from 'flarum/common/extend';
import PostStream from 'flarum/forum/components/PostStream';
import { waitOrderMap } from '../utils/ThreadOrderPrefetch';

const BIG = 1e9;

/* ---------------- 工具 ---------------- */

function getDidFromComponent(ps) {
  try {
    return ps?.stream?.discussion?.id?.() ?? null;
  } catch {
    return null;
  }
}

function getContainer(ps) {
  if (ps?.element?.classList?.contains('PostStream')) return ps.element;
  const found = ps?.element?.querySelector?.('.PostStream');
  return found || document.querySelector('.PostStream') || null;
}

function isPostItem(el) {
  return el && el.nodeType === 1 && el.matches('.PostStream-item[data-id]');
}

function collectChildren(container) {
  return Array.from(container?.children || []);
}

function findPostsRange(container) {
  const kids = collectChildren(container);
  if (!kids.length) return { posts: [], left: -1, right: -1, anchor: null };

  let L = kids.findIndex(isPostItem);
  if (L < 0) return { posts: [], left: -1, right: -1, anchor: kids[0] || null };

  let R = kids.length - 1 - [...kids].reverse().findIndex(isPostItem);
  if (R < L) R = L;

  const posts = kids.slice(L, R + 1).filter(isPostItem);
  const anchor = kids[R + 1] || null; // 段后第一个兄弟
  return { posts, left: L, right: R, anchor };
}

function getNearIdFromURL() {
  try {
    const usp = new URLSearchParams(location.search);
    const near = usp.get('near');
    if (near && /^\d+$/.test(near)) return Number(near);

    const m = (location.hash || '').match(/#p(\d+)/);
    if (m) return Number(m[1]);
  } catch {}
  return null;
}

function recenterIfNeeded(container, targetId, onceFlagObj) {
  if (!targetId || onceFlagObj.done) return;
  const el = container?.querySelector?.(`.PostStream-item[data-id="${targetId}"]`);
  if (!el) return;
  try {
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    onceFlagObj.done = true;
  } catch {}
}

/* ---------------- 核心：计算目标序列 ---------------- */

/**
 * 生成“节点元数据”数组：
 * - id: number
 * - el: Element
 * - rec: orderMap 记录（可能不存在）
 * - movable: 是否可移动（根或父子同窗）
 * - baseOrder: 数轴上的排序键（先留空，稍后补）
 */
function buildNodes(container, posts, orderMap) {
  const presentIds = new Set(posts.map((el) => Number(el.dataset.id)));
  const nodes = posts.map((el) => {
    const id = Number(el.dataset.id);
    const rec = orderMap.get(id); // {order, depth, parentId} | undefined

    let movable = false;
    if (rec) {
      if (rec.parentId == null) movable = true; // 根帖
      else if (presentIds.has(rec.parentId)) movable = true; // 父子同窗
      else movable = false; // 父不在窗 -> 暂不移动
    } else {
      movable = false; // 事件帖/其它：不在 orderMap
    }

    return {
      id,
      el,
      rec: rec || null,
      movable,
      baseOrder: rec ? Number(rec.order) : NaN, // 先放 known 值；其余稍后插值
    };
  });

  // 为 baseOrder 为空(NaN)的节点做“邻近插值”：
  // 思路：向左/右寻找最近的已知 baseOrder，取中点；仅用于让可移动评论跨越它们。
  // 两趟扫描：记录每个位置左/右最近的已知值。
  const n = nodes.length;
  const leftKnown = new Array(n).fill(null);
  const rightKnown = new Array(n).fill(null);

  let last = null;
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(nodes[i].baseOrder)) last = nodes[i].baseOrder;
    leftKnown[i] = last;
  }
  last = null;
  for (let i = n - 1; i >= 0; i--) {
    if (Number.isFinite(nodes[i].baseOrder)) last = nodes[i].baseOrder;
    rightKnown[i] = last;
  }

  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(nodes[i].baseOrder)) {
      const L = leftKnown[i];
      const R = rightKnown[i];
      if (Number.isFinite(L) && Number.isFinite(R)) nodes[i].baseOrder = (L + R) / 2;
      else if (Number.isFinite(L)) nodes[i].baseOrder = L + 0.5;
      else if (Number.isFinite(R)) nodes[i].baseOrder = R - 0.5;
      else nodes[i].baseOrder = BIG + i; // 极端兜底：没有任何已知点
    }
  }

  // 细微去重：若 baseOrder 完全相同，按 id 提供一个极小偏移，保证稳定比较
  // 同时确保数值安全（不影响整体相对大小）
  const seen = new Map();
  for (const node of nodes) {
    const k = node.baseOrder;
    const count = seen.get(k) || 0;
    if (count) node.baseOrder = k + count * 1e-6;
    seen.set(k, count + 1);
  }

  return nodes;
}

/**
 * 计算目标序列（按 baseOrder 升序、再按 id 升序）
 * 返回一个“节点元数据”数组，包含所有帖子（可移动+固定）。
 */
function computeTarget(nodes) {
  return nodes
    .slice()
    .sort((a, b) => {
      if (a.baseOrder !== b.baseOrder) return a.baseOrder - b.baseOrder;
      return a.id - b.id;
    });
}

/* ---------------- 应用到 DOM（只搬可移动） ---------------- */

/**
 * 自右向左，将每个“可移动评论”插到它“下一个目标兄弟”之前。
 * 好处：右侧的参照节点已在最终位置，insertBefore 总是有效；固定节点保持原位。
 */
function applyOrder(container, targetNodes) {
  for (let i = targetNodes.length - 1; i >= 0; i--) {
    const cur = targetNodes[i];
    if (!cur.movable) continue; // 固定节点不搬家

    const nextEl = i + 1 < targetNodes.length ? targetNodes[i + 1].el : null;

    // 参照节点必须仍在同一 container，缺失则 append。
    const ref =
      nextEl && nextEl.parentNode === container ? nextEl : null;

    // 当前节点必须也在 container 内
    if (!cur.el || cur.el.parentNode !== container) continue;

    try {
      container.insertBefore(cur.el, ref);
    } catch (e) {
      // 极端竞态：下一轮再排
      // eslint-disable-next-line no-console
      console.warn('[Threadify] insertBefore failed; will retry', e);
    }
  }
}

/* ---------------- 一次重排流程 ---------------- */

function reorderOnce(container, did, centerFlagObj) {
  return waitOrderMap(did)
    .then((map) => {
      const { posts } = findPostsRange(container);
      if (!posts.length) return;

      const nodes = buildNodes(container, posts, map || new Map());
      const target = computeTarget(nodes);

      applyOrder(container, target);

      // 首轮 near/#p 回中（只做一次）
      recenterIfNeeded(container, getNearIdFromURL(), centerFlagObj);
    })
    .catch((e) => {
      // eslint-disable-next-line no-console
      console.warn('[Threadify] order map unavailable', e);
    });
}

/* ---------------- 生命周期挂钩 ---------------- */

export function installDomReorderMode() {
  extend(PostStream.prototype, 'oncreate', function () {
    const did = getDidFromComponent(this);
    const container = getContainer(this);
    if (!did || !container) return;

    // 首次：拉取并重排；near/#p 在首轮后回中一次
    this.__threadifyNearCentered = { done: false };
    reorderOnce(container, did, this.__threadifyNearCentered);

    // 监听 Realtime/分页的子节点变化，下一帧执行一次重排
    let scheduled = false;
    const observer = new MutationObserver((muts) => {
      if (!muts.some((m) => m.type === 'childList')) return;
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        reorderOnce(container, did, this.__threadifyNearCentered);
      });
    });

    observer.observe(container, { childList: true });
    this.__threadifyDomObserver = observer;
  });

  extend(PostStream.prototype, 'onupdate', function () {
    const did = getDidFromComponent(this);
    const container = getContainer(this);
    if (!did || !container) return;
    reorderOnce(container, did, this.__threadifyNearCentered || { done: true });
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
