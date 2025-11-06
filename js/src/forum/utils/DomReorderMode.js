// js/src/forum/utils/DomReorderMode.js
// 仅在“同窗”内重排；子树一致（父不参与则整棵子树不参与）；事件帖作为根参与；
// 统一使用 ThreadOrderPrefetch 的缓存；插入前复核 anchor，避免 NotFoundError。

import app from 'flarum/forum/app';
import { extend } from 'flarum/common/extend';
import PostStream from 'flarum/forum/components/PostStream';
import { waitOrderMap } from '../utils/ThreadOrderPrefetch';

const BIG = 10_000_000;

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
function isEventPost(model) {
  // 大多数事件帖没有有效楼层号；把“无 number 的帖子”视为事件帖
  return !Number.isFinite(getNumber(model));
}

/* ---------- order key with fallbacks ---------- */
function orderKey(orderRec, model, id) {
  // 1) 服务器线程顺序
  if (orderRec && Number.isFinite(orderRec.order)) return Number(orderRec.order);
  // 2) 楼层号
  const n = getNumber(model);
  if (n != null) return n;
  // 3) 创建时间（置于 BIG/2 段，避免小序列冲突）
  const t = getCreatedTs(model);
  if (t != null) return BIG / 2 + t;
  // 4) 最后兜底
  return BIG + Number(id);
}

/* ---------- eligibility: subtree-consistent & in-window ---------- */
function computeEligibility(container, posts, orderMap) {
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

  // 第一轮：根 & 事件帖 参与
  const eligible = new Set();
  for (const el of posts) {
    const id = Number(el.dataset.id);
    const m = models.get(id);
    const pid = parentOf.get(id);
    if (pid == null || isEventPost(m)) eligible.add(id);
  }

  // 迭代：只有当“父 已 eligible 且 在当前 DOM”时，子才 eligible
  let changed = true;
  while (changed) {
    changed = false;
    for (const el of posts) {
      const id = Number(el.dataset.id);
      if (eligible.has(id)) continue;
      const pid = parentOf.get(id);
      if (pid == null) continue;
      if (!present.has(pid)) continue;     // 父不在窗：整棵子树留在原地
      if (!eligible.has(pid)) continue;    // 父未纳入：整棵子树留在原地
      eligible.add(id);
      changed = true;
    }
  }

  return { eligible, models };
}

/* ---------- build target sequence: replace only eligible slots ---------- */
function computeTarget(posts, eligible, orderMap, models) {
  const eligList = posts.filter((el) => eligible.has(Number(el.dataset.id)));
  const sortedElig = eligList.slice().sort((a, b) => {
    const ida = Number(a.dataset.id), idb = Number(b.dataset.id);
    const ka = orderKey(orderMap.get(ida), models.get(ida), ida);
    const kb = orderKey(orderMap.get(idb), models.get(idb), idb);
    return ka === kb ? ida - idb : ka - kb;
  });

  const out = [];
  let j = 0;
  for (const el of posts) {
    const id = Number(el.dataset.id);
    out.push(eligible.has(id) ? sortedElig[j++] : el);
  }
  return out;
}

/* ---------- one-shot reorder ---------- */
function reorderOnce(container, did) {
  return waitOrderMap(did)
    .then((orderMap) => {
      const { posts } = findPostsRange(container);
      if (!posts.length) return;

      const { eligible, models } = computeEligibility(container, posts, orderMap || new Map());
      const target = computeTarget(posts, eligible, orderMap || new Map(), models);

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
        console.warn('[Threadify] reorder failed (retry next tick)', e);
      }
    })
    .catch((e) => {
      console.warn('[Threadify] order map unavailable', e);
    });
}

/* ---------- lifecycle ---------- */
export function installDomReorderMode() {
  extend(PostStream.prototype, 'oncreate', function () {
    const did = getDidFromComponent(this);
    const container = getContainer(this);
    if (!did || !container) return;

    // 首次
    reorderOnce(container, did);

    // 监听子节点变化（分页/Realtime），下一帧执行
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
      try { this.__threadifyDomObserver.disconnect(); } catch {}
      this.__threadifyDomObserver = null;
    }
  });
}
