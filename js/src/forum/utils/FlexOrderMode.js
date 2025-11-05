// js/src/forum/utils/FlexOrderMode.js
//
// DOM 物理重排（与 Scrubber/地址栏楼层号完全兼容）
// 仅依赖 ThreadOrderPrefetch.js 暴露的 3 个函数：
//   - prefetchThreadOrder(did)
//   - getOrderIndex(did, postId)
//   - getDepthPrefetched(did, postId)
//
// 不使用任何额外导出，避免“导出不匹配”导致整个模块失效。
// -----------------------------------------------------------------------------

import { extend, override } from 'flarum/common/extend';
import PostStream from 'flarum/forum/components/PostStream';
import PostStreamState from 'flarum/forum/states/PostStreamState';
import {
  prefetchThreadOrder,
  getOrderIndex,
  getDepthPrefetched,
} from '../utils/ThreadOrderPrefetch';

let suspendApply = false;     // 分页期间暂停应用
let pendingApply = false;     // 分页结束后补一次
let rafId = 0;                // rAF 句柄
let mo = null;                // MutationObserver
let lastSig = '';             // 上次应用的序列签名

export function installFlexOrderMode() {
  // 分页 hook：加载期间暂停排序，加载后补一次
  override(PostStreamState.prototype, '_loadPrevious', function (original, ...args) {
    suspendApply = true;
    const p = original(...args);
    return Promise.resolve(p).finally(() => {
      suspendApply = false;
      if (pendingApply) { pendingApply = false; scheduleApply(); }
    });
  });

  override(PostStreamState.prototype, '_loadNext', function (original, ...args) {
    suspendApply = true;
    const p = original(...args);
    return Promise.resolve(p).finally(() => {
      suspendApply = false;
      if (pendingApply) { pendingApply = false; scheduleApply(); }
    });
  });

  // 生命周期：创建/更新/移除
  extend(PostStream.prototype, 'oncreate', function () {
    const did = getDid();
    if (did) prefetchThreadOrder(did).finally(() => scheduleApply());

    const container = getContainer();
    if (container) attachObserver(container);

    scheduleApply();
  });

  extend(PostStream.prototype, 'onupdate', function () {
    scheduleApply();
  });

  extend(PostStream.prototype, 'onremove', function () {
    detachObserver();
    lastSig = '';
  });

  // 讨论切换（前进后退）
  window.addEventListener('popstate', () => {
    lastSig = '';
    const did = getDid();
    if (did) prefetchThreadOrder(did).finally(() => scheduleApply());
    else scheduleApply();
  });
}

// ============ 排序主流程 ============

function scheduleApply() {
  if (suspendApply) { pendingApply = true; return; }
  if (rafId) cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(() => {
    applyDomReorder().catch((e) => console.warn('[Threadify] reorder failed:', e));
  });
}

async function applyDomReorder() {
  const did = getDid();
  const container = getContainer();
  if (!did || !container) return;

  // 收集“真实楼层”节点
  const { posts, anchorAfterRange } = collectItems(container);
  if (!posts.length) return;

  // 生成排序后的目标序列（仅依赖 getOrderIndex）
  const sorted = sortByOrderIndex(did, posts);

  // 已经是目标序列就不动
  if (sameNodes(posts, sorted)) return;

  // 物理重排（insertBefore）
  for (const el of sorted) container.insertBefore(el, anchorAfterRange);

  lastSig = signature(sorted);

  // 可选：给每条楼层的 article.Post 加 thread-depth-* 视觉类（不影响 Scrubber）
  tryApplyDepthClasses(did, sorted);
}

// ============ DOM/节点辅助 ============

function getContainer() {
  return document.querySelector('.PostStream') || null;
}

function collectItems(container) {
  const kids = Array.from(container.children || []);
  const isPost = (el) =>
    el && el.nodeType === 1 &&
    el.classList?.contains('PostStream-item') &&
    el.hasAttribute('data-id');

  let L = -1, R = -1;
  for (let i = 0; i < kids.length; i++) { if (isPost(kids[i])) { L = i; break; } }
  if (L >= 0) {
    for (let j = kids.length - 1; j >= L; j--) { if (isPost(kids[j])) { R = j; break; } }
  }

  const posts = (L >= 0 && R >= L) ? kids.slice(L, R + 1).filter(isPost) : [];
  const anchorAfterRange = kids[R + 1] || null;

  return { posts, anchorAfterRange };
}

function sortByOrderIndex(did, posts) {
  const BIG = 10_000_000;
  const arr = posts.slice(); // 拷贝
  arr.sort((a, b) => {
    const ida = +a.dataset.id;
    const idb = +b.dataset.id;
    const oa = getOrderIndex(did, ida);
    const ob = getOrderIndex(did, idb);
    const A = Number.isInteger(oa) ? oa : (BIG + ida);
    const B = Number.isInteger(ob) ? ob : (BIG + idb);
    return (A === B) ? (ida - idb) : (A - B);
  });
  return arr;
}

function sameNodes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function signature(nodes) {
  try { return nodes.map(n => n.dataset.id).join(','); } catch { return ''; }
}

function tryApplyDepthClasses(did, postItems) {
  for (const item of postItems) {
    const id = +item.dataset.id;
    const article = item.querySelector && item.querySelector('article.Post');
    if (!article) continue;

    // 清旧类
    const rm = [];
    article.classList.forEach((c) => {
      if (c.indexOf('thread-depth-') === 0 || c === 'threaded-post' || c === 'thread-root' || c === 'thread-deep' || c === 'thread-very-deep') {
        rm.push(c);
      }
    });
    rm.forEach((c) => article.classList.remove(c));

    const depth = getDepthPrefetched(did, id) ?? 0;
    if (depth > 0) {
      article.classList.add('threaded-post', `thread-depth-${Math.min(depth, 10)}`);
      if (depth >= 3) article.classList.add('thread-deep');
      if (depth >= 5) article.classList.add('thread-very-deep');
    } else {
      article.classList.add('thread-root');
    }
  }
}

// ============ 观察器 ============

function attachObserver(container) {
  detachObserver();
  mo = new MutationObserver((mut) => {
    // 出现/移除楼层节点，就在下一帧重排
    for (const m of mut) {
      if (m.type === 'childList' && (m.addedNodes?.length || m.removedNodes?.length)) {
        scheduleApply(); break;
      }
    }
  });
  mo.observe(container, { childList: true });
}

function detachObserver() {
  if (mo) {
    try { mo.disconnect(); } catch {}
    mo = null;
  }
}

// ============ 获取讨论 ID ============

function getDid() {
  const segs = (location.pathname || '').split('/').filter(Boolean);
  const i = segs.indexOf('d');
  if (i >= 0 && segs[i + 1]) {
    const m = segs[i + 1].match(/^(\d+)/);
    if (m) return Number(m[1]);
  }
  return null;
}
