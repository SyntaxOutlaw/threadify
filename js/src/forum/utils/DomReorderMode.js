// js/src/forum/utils/DomReorderMode.js
// 仅在“同窗”内重排；子树一致（父不参与则整棵子树不参与）；事件帖二阶段按时间就位；
// Realtime 兼容：检测新增节点后强制刷新顺序表并立刻重排；
// 作者侧“半水合”修复：监听 data-id/class 属性就绪即强刷 + 重排 + 轻量 redraw；
// 锁定子树黏连（cohesion）：保证 locked 父与其 locked 子孙在同窗内连续贴近；
// 统一使用 ThreadOrderPrefetch 的缓存；插入前复核 anchor，避免 NotFoundError。

import app from 'flarum/forum/app';
import { extend } from 'flarum/common/extend';
import PostStream from 'flarum/forum/components/PostStream';
import {
  waitOrderMap,
  prefetchThreadOrder,
  invalidateThreadOrder,
} from '../utils/ThreadOrderPrefetch';

const BIG = 10_000_000;

/* ---------- utils: mithril redraw throttle ---------- */
let redrawScheduled = false;
function scheduleRedraw() {
  if (redrawScheduled) return;
  redrawScheduled = true;
  try {
    requestAnimationFrame(() => {
      redrawScheduled = false;
      if (typeof m === 'function' && typeof m.redraw === 'function') m.redraw();
    });
  } catch (_) {
    redrawScheduled = false;
  }
}

/* ---------- DOM helpers ---------- */
function getDidFromComponent(ps) {
  try { return ps?.stream?.discussion?.id?.() ?? null; } catch { return null; }
}
function getContainer(ps) {
  if (ps?.element?.classList?.contains('PostStream')) return ps.element;
  return ps?.element?.querySelector?.('.PostStream') || document.querySelector('.PostStream') || null;
}
function isPostItem(el) {
  return el && el.nodeType === 1 && el.matches('.PostStream-item[data-id]');
}
function findPostsRange(container) {
  const kids = Array.from(container?.children || []);
  if (!kids.length) return { posts: [], anchor: null };
  let L = kids.findIndex(isPostItem);
  if (L < 0) return { posts: [], anchor: kids[0] || null };
  let R = kids.length - 1 - [...kids].reverse().findIndex(isPostItem);
  if (R < L) R = L;
  const posts = kids.slice(L, R + 1).filter(isPostItem);
  const anchor = kids[R + 1] || null;
  return { posts, anchor };
}
function sameOrder(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/* ---------- model helpers ---------- */
function getModel(id) {
  try { return app.store.getById('posts', String(id)); } catch { return null; }
}
function getNumber(model) {
  try {
    const n = model && typeof model.number === 'function' ? model.number() : null;
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}
function getCreatedTs(model) {
  try {
    const d = model && typeof model.createdAt === 'function' ? model.createdAt() : null;
    return d instanceof Date ? d.getTime() : null;
  } catch { return null; }
}
function getContentType(model) {
  try {
    if (!model) return null;
    if (typeof model.contentType === 'function') return model.contentType();
    if (typeof model.attribute === 'function') return model.attribute('contentType') ?? null;
  } catch {}
  return null;
}
function isEventPostByEl(el, model) {
  // 首选：contentType !== 'comment'
  const ct = getContentType(model);
  if (ct && ct !== 'comment') return true;
  // 兜底：DOM 线索（常见类名）
  if (el?.classList?.contains('EventPost') || el?.classList?.contains('Post-event')) return true;
  if (el?.querySelector?.('.EventPost, .Post-event, .EventPost-icon')) return true;
  return false;
}

/* ---------- order keys ---------- */
function orderKey(orderRec, model, id) {
  // 1) 服务器线程顺序
  if (orderRec && Number.isFinite(orderRec.order)) return Number(orderRec.order);
  // 2) 楼层号
  const n = getNumber(model);
  if (n != null) return n;
  // 3) 创建时间（置于 BIG/2 段，避免与 number 冲突）
  const t = getCreatedTs(model);
  if (t != null) return BIG / 2 + t;
  // 4) 最后兜底
  return BIG + Number(id);
}

// 线性时间键（用于事件帖时间就位 & 锁定黏连排序）
function linearKey(model, id) {
  const t = getCreatedTs(model);
  if (t != null) return t;
  const n = getNumber(model);
  if (n != null) return BIG / 2 + n;
  return BIG + Number(id);
}

/* ---------- eligibility: subtree-consistent & in-window ---------- */
function computeEligibility(posts, orderMap) {
  const present = new Set(posts.map((el) => Number(el.dataset.id)));
  const models = new Map(posts.map((el) => [Number(el.dataset.id), getModel(Number(el.dataset.id))]));

  // parentOf：优先线程表 parentId；没有就读模型的 parent_id
  const parentOf = new Map();
  for (const el of posts) {
    const id = Number(el.dataset.id);
    const rec = orderMap.get(id);
    const m = models.get(id);
    const pid = rec ? rec.parentId : (m?.attribute ? m.attribute('parent_id') : null);
    parentOf.set(id, pid == null ? null : Number(pid));
  }

  // 事件帖集合（不受父链限制，二阶段全局放置）
  const events = new Set();
  for (const el of posts) {
    const id = Number(el.dataset.id);
    const m = models.get(id);
    if (isEventPostByEl(el, m)) events.add(id);
  }

  // 第一轮：评论根（pid==null）参与；事件帖不放进 eligible（留给第二阶段全局插入）
  const eligible = new Set();
  for (const el of posts) {
    const id = Number(el.dataset.id);
    if (events.has(id)) continue; // 事件帖：二阶段处理
    const pid = parentOf.get(id);
    if (pid == null) eligible.add(id);
  }

  // 迭代：只有当“父 已 eligible 且 在当前 DOM”时，子才 eligible
  let changed = true;
  while (changed) {
    changed = false;
    for (const el of posts) {
      const id = Number(el.dataset.id);
      if (eligible.has(id) || events.has(id)) continue; // 事件帖跳过
      const pid = parentOf.get(id);
      if (pid == null) continue;
      if (!present.has(pid)) continue;     // 父不在窗：整棵子树留在原地
      if (!eligible.has(pid)) continue;    // 父未纳入：整棵子树留在原地
      eligible.add(id);
      changed = true;
    }
  }

  return { eligible, events, models, parentOf, present };
}

/* ---------- build: phase1 comments + phase2 events ---------- */
/**
 * 两阶段：
 * 1) 评论：只替换 eligible 槽位（子树一致 + 同窗）
 * 2) 事件帖：从结果中“拿出所有事件帖”，按 createdAt 升序，
 *    逐个插到“第一条时间 > 它 的评论”之前（没有则追加到末尾）
 */
function buildBaseTarget(posts, eligible, events, orderMap, models) {
  // 1) 评论先排好（只替换 eligible 槽位）
  const eligList = posts.filter((el) => eligible.has(Number(el.dataset.id)));
  const sortedElig = eligList.slice().sort((a, b) => {
    const ida = Number(a.dataset.id), idb = Number(b.dataset.id);
    const ka = orderKey(orderMap.get(ida), models.get(ida), ida);
    const kb = orderKey(orderMap.get(idb), models.get(idb), idb);
    return ka === kb ? ida - idb : ka - kb;
  });

  const base = [];
  let j = 0;
  for (const el of posts) {
    const id = Number(el.dataset.id);
    if (eligible.has(id)) base.push(sortedElig[j++]);
    else base.push(el);
  }

  // 2) 事件帖全局时间就位：先拿掉所有事件帖，再按时间插回
  const withoutEvents = base.filter((el) => !events.has(Number(el.dataset.id)));
  const evtList = posts.filter((el) => events.has(Number(el.dataset.id)));

  // 事件帖按时间升序（时间相同按 id）
  evtList.sort((a, b) => {
    const ida = Number(a.dataset.id), idb = Number(b.dataset.id);
    const ka = linearKey(models.get(ida), ida);
    const kb = linearKey(models.get(idb), idb);
    return ka === kb ? ida - idb : ka - kb;
  });

  // 为评论建立“线性时间键”
  function commentKey(el) {
    const id = Number(el.dataset.id);
    return linearKey(models.get(id), id);
  }

  // 插入规则：插到“第一条 key > 事件 key 的评论”之前；没有就追加到末尾
  const out = withoutEvents.slice();
  for (const evEl of evtList) {
    const eid = Number(evEl.dataset.id);
    const ek = linearKey(models.get(eid), eid);
    let insertAt = -1;
    for (let i = 0; i < out.length; i++) {
      const ck = commentKey(out[i]);
      if (ck > ek) { insertAt = i; break; }
    }
    if (insertAt === -1) out.push(evEl);
    else out.splice(insertAt, 0, evEl);
  }

  return out;
}

/* ---------- phase3: locked cohesion (压实同窗 locked 子树) ---------- */
function applyLockedCohesion(sequence, eligible, events, models, parentOf) {
  // sequence: 当前最终顺序（DOM 节点数组）
  const presentIds = sequence.map((el) => Number(el.dataset.id));
  const present = new Set(presentIds);

  // locked = 非事件、非 eligible
  const locked = new Set(presentIds.filter((id) => !events.has(id) && !eligible.has(id)));
  if (!locked.size) return sequence;

  // 最近可见 locked 祖先
  function nearestVisibleLockedAncestor(id) {
    let cur = id;
    for (let guard = 0; guard < 100; guard++) {
      const pid = parentOf.get(cur);
      if (pid == null) return null;
      if (!present.has(pid)) return null;
      if (locked.has(pid)) return pid;
      cur = pid;
    }
    return null;
  }

  // rootId -> members(Set)
  const groups = new Map();
  for (const id of locked) {
    const root = nearestVisibleLockedAncestor(id);
    if (root == null || root === id) continue;
    if (!groups.has(root)) groups.set(root, new Set());
    groups.get(root).add(id);
  }
  if (!groups.size) return sequence;

  // index 映射
  const indexOfId = new Map(sequence.map((el, idx) => [Number(el.dataset.id), idx]));
  const sortedRoots = Array.from(groups.keys()).sort((a, b) => (indexOfId.get(a) - indexOfId.get(b)));

  // 生成 id -> el 快查
  const byIdEl = new Map(sequence.map((el) => [Number(el.dataset.id), el]));

  // 可变数组操作副本
  const out = sequence.slice();

  // 帮助：移除一系列成员（id）并返回它们（保持原顺序）
  function extractMembers(ids) {
    // 根据 out 中现有顺序取出
    const set = new Set(ids);
    const picked = [];
    for (let i = 0; i < out.length; i++) {
      const id = Number(out[i].dataset.id);
      if (set.has(id)) { picked.push(out[i]); out.splice(i, 1); i--; }
    }
    return picked;
  }

  for (const rootId of sortedRoots) {
    const rootIdx = out.findIndex((el) => Number(el.dataset.id) === rootId);
    if (rootIdx < 0) continue;

    // 成员按线性时间键排序
    const memberIds = Array.from(groups.get(rootId));
    memberIds.sort((a, b) => {
      const ka = linearKey(models.get(a), a);
      const kb = linearKey(models.get(b), b);
      return ka === kb ? a - b : ka - kb;
    });

    const membersEls = extractMembers(memberIds);

    // 插到 root 后面（保持成员内部顺序）
    out.splice(rootIdx + 1, 0, ...membersEls);
  }

  return out;
}

/* ---------- one-shot reorder pipeline ---------- */
async function reorderOnce(container, did) {
  const orderMap = (await waitOrderMap(did)) || new Map();
  const { posts } = findPostsRange(container);
  if (!posts.length) return;

  const { eligible, events, models, parentOf } = computeEligibility(posts, orderMap);
  // Phase 1 & 2
  const base = buildBaseTarget(posts, eligible, events, orderMap, models);
  // Phase 3: cohesion
  const target = applyLockedCohesion(base, eligible, events, models, parentOf);

  if (sameOrder(posts, target)) return;

  // 插入前复核 anchor，避免 NotFoundError
  const latest = findPostsRange(container);
  const anchor = (latest.anchor && latest.anchor.parentNode === container) ? latest.anchor : null;

  try {
    for (const el of target) {
      if (anchor && anchor.parentNode === container) container.insertBefore(el, anchor);
      else container.appendChild(el);
    }
  } catch (e) {
    console.warn('[Threadify] reorder failed (will retry)', e);
  }

  // 轻量重绘，触发 Post.prototype.classes 重新计算缩进
  scheduleRedraw();
}

/* ---------- lifecycle with realtime + hydration paths ---------- */
export function installDomReorderMode() {
  extend(PostStream.prototype, 'oncreate', function () {
    const did = getDidFromComponent(this);
    const container = getContainer(this);
    if (!did || !container) return;

    // 首次
    reorderOnce(container, did);

    // 监听子节点变化（分页/Realtime）+ 属性就绪（作者侧半水合）
    let scheduled = false;
    let isReordering = false;
    let coalesceTimer = null;

    const observer = new MutationObserver((muts) => {
      const childMut = muts.filter((m) => m.type === 'childList');
      const added = childMut
        .flatMap((m) => Array.from(m.addedNodes || []))
        .filter((n) => n && n.nodeType === 1 && n.matches && n.matches('.PostStream-item[data-id]'));

      // —— Realtime/分页：新增了可识别帖子节点 —— //
      if (added.length) {
        if (isReordering) return;
        clearTimeout(coalesceTimer);
        coalesceTimer = setTimeout(async () => {
          isReordering = true;
          try {
            const map = (await waitOrderMap(did)) || new Map();
            const missing = added.some((el) => !map.has(Number(el.dataset.id)));
            if (missing) {
              invalidateThreadOrder(did);
              await prefetchThreadOrder(did, { force: true });
            }
            await reorderOnce(container, did);
          } catch (e) {
            console.warn('[Threadify] realtime reorder failed', e);
          } finally {
            isReordering = false;
          }
        }, 16);
        return; // 本轮不再走 rAF 调度
      }

      // —— 作者侧半水合：属性就绪（data-id/class） —— //
      const attrMut = muts.filter((m) => m.type === 'attributes');
      const hydrationHit = attrMut.some((m) => {
        const el = m.target;
        if (!el || !el.matches || !el.matches('.PostStream-item')) return false;
        if (m.attributeName === 'data-id') {
          // 刚获得 data-id
          return !!el.getAttribute('data-id');
        }
        if (m.attributeName === 'class') {
          // 从 saving/占位变为正常渲染（宽松匹配）
          const cl = el.className || '';
          return /PostStream-item/.test(cl) && /Post--saving/.test(m.oldValue || '') && !/Post--saving/.test(cl);
        }
        return false;
      });

      if (hydrationHit) {
        if (isReordering) return;
        clearTimeout(coalesceTimer);
        coalesceTimer = setTimeout(async () => {
          isReordering = true;
          try {
            invalidateThreadOrder(did);
            await prefetchThreadOrder(did, { force: true });
            await reorderOnce(container, did);
          } catch (e) {
            console.warn('[Threadify] hydration reorder failed', e);
          } finally {
            isReordering = false;
          }
        }, 16);
        return;
      }

      // —— 无新增/无属性就绪：轻量归一化（分页/微抖动） —— //
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        reorderOnce(container, did);
      });
    });

    observer.observe(container, {
      childList: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ['data-id', 'class'],
      subtree: true,
    });

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
      try { this.__threadifyDomObserver.disconnect(); } catch {}
      this.__threadifyDomObserver = null;
    }
  });

  // 预取就绪时轻量 redraw，保证缩进类尽快正确
  try {
    window.addEventListener('threadify:order-ready', () => scheduleRedraw());
  } catch (_) {}
}
