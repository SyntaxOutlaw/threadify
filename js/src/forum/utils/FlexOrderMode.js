// js/src/forum/utils/FlexOrderMode.js
//
// “Flex 排序模式”：不改 PostStream 的 posts() 顺序；
// 仅在 DOM 层对每个 article.Post[data-id] 设置 CSS order，
// 并据预取的深度为其打上 thread-depth-* 类名。
// 分页（_loadPrevious/_loadNext）时自动暂停应用，结束后再批量应用。
// 新回复出现时自动刷新预取并重排。
// 附带“轻门帘”：预取未就绪时把 Post 容器临时设为透明，避免短暂未排序闪动。
// -----------------------------------------------------------------------------

import { extend, override } from 'flarum/common/extend';
import PostStream from 'flarum/forum/components/PostStream';
import PostStreamState from 'flarum/forum/states/PostStreamState';
import { prefetchThreadOrder, getOrderIndex, getDepthPrefetched } from './ThreadOrderPrefetch';

let suspendApply = false;       // 分页期间暂停应用
let pendingApply = false;       // 分页结束后补一次
let currentDiscussionId = null; // 追踪当前讨论
let scheduled = null;           // RAF 调度句柄
let seenIds = new Set();        // 已见帖子 ID（用来侦测“新回复”）

// 轻门帘延时（毫秒）：预取若很快完成，则始终无闪动；超过这个时间也会自动显示
const VEIL_MAX_WAIT = 180;

export function installFlexOrderMode() {
  // 分页前后切换“暂停标志”
  override(PostStreamState.prototype, '_loadPrevious', function (original, ...args) {
    suspendApply = true;
    const p = original(...args);
    return Promise.resolve(p).finally(() => {
      suspendApply = false;
      if (pendingApply) { pendingApply = false; applySoonFromState(this); }
    });
  });

  override(PostStreamState.prototype, '_loadNext', function (original, ...args) {
    suspendApply = true;
    const p = original(...args);
    return Promise.resolve(p).finally(() => {
      suspendApply = false;
      if (pendingApply) { pendingApply = false; applySoonFromState(this); }
    });
  });

  // PostStream 生命周期：首次创建与后续更新都尝试应用
  extend(PostStream.prototype, 'oncreate', function () {
    const did = this.stream && this.stream.discussion && this.stream.discussion.id();
    if (currentDiscussionId !== did) {
      currentDiscussionId = did;
      seenIds.clear();
    }
    // 轻门帘：预取很快则看不到；慢了最多 VEIL_MAX_WAIT ms
    tryVeilUntilOrderReady(this, did);
    scheduleApply(this);
  });

  extend(PostStream.prototype, 'onupdate', function () {
    // 发现“新帖子” → 触发一次预取刷新后再应用
    const did = this.stream && this.stream.discussion && this.stream.discussion.id();
    const idsNow = collectIds(this.element);
    let hasNew = false;
    idsNow.forEach((id) => {
      if (!seenIds.has(id)) { hasNew = true; seenIds.add(id); }
    });
    if (hasNew && did) {
      prefetchThreadOrder(did).finally(() => scheduleApply(this));
    } else {
      scheduleApply(this);
    }
  });

  // 当预取完成时（任意来源触发），如果正处在相同讨论页，则立即应用
  window.addEventListener('threadify:order-ready', (ev) => {
    const didReady = ev && ev.detail && ev.detail.discussionId;
    if (!didReady) return;
    // 找到页面上第一个 PostStream 容器，尝试应用
    const ps = findActivePostStream();
    if (!ps) return;
    const did = ps.stream && ps.stream.discussion && ps.stream.discussion.id();
    if (Number(did) === Number(didReady)) scheduleApply(ps);
  });
}

// ============ 内部：应用顺序与深度类名（DOM 层） ============

function scheduleApply(postStream) {
  if (suspendApply) { pendingApply = true; return; }
  if (scheduled) cancelAnimationFrame(scheduled);
  scheduled = requestAnimationFrame(() => {
    try {
      applyFlexOrder(postStream);
    } catch (e) {
      console.warn('[Threadify] flex apply failed:', e);
    }
  });
}

function applySoonFromState(state) {
  // state 是 PostStreamState；拿到对应的 PostStream 实例
  const ps = state.discussion && state.discussion.postStream ? state.discussion.postStream : null;
  if (ps) scheduleApply(ps);
}

function applyFlexOrder(postStream) {
  const root = postStream && postStream.element;
  if (!root) return;

  // 找到 Post 容器和帖子节点
  const container = queryPostContainer(root);
  if (!container) return;

  // 将容器变成 flex 列，且不破坏主题布局（只在我们这层加内联样式）
  ensureFlexContainer(container);

  const did = postStream.stream && postStream.stream.discussion && postStream.stream.discussion.id();

  // 只处理真正的帖子节点（必须有 data-id）
  const posts = Array.from(container.querySelectorAll('article.Post[data-id]'));

  // 更新 seenIds
  posts.forEach((n) => { const id = Number(n.dataset.id); if (Number.isFinite(id)) seenIds.add(id); });

  // 批量写入 CSS order 与 thread-depth-* 类
  posts.forEach((node) => {
    const id = Number(node.dataset.id);
    if (!Number.isFinite(id)) return;

    const order = getOrderIndex(did, id);
    // 未命中顺序就给一个很靠后的 fallback（仍然稳定）
    const ord = Number.isInteger(order) ? order : 10_000_000 + id;
    node.style.order = String(ord);

    // 深度类：先清除旧的 thread-depth-*，再按预取写入
    cleanupDepthClasses(node);
    const depth = getDepthPrefetched(did, id);
    if (Number.isFinite(depth) && depth > 0) {
      node.classList.add('threaded-post', `thread-depth-${Math.min(depth, 10)}`);
      if (depth >= 3) node.classList.add('thread-deep');
      if (depth >= 5) node.classList.add('thread-very-deep');
    } else {
      node.classList.add('thread-root');
    }
  });
}

// ============ 工具函数 ============

function queryPostContainer(rootEl) {
  // 常见结构下，PostStream 的根就是帖子容器；同时兜底几个常用类名
  if (!rootEl) return null;
  if (rootEl.classList && (rootEl.classList.contains('PostStream') || rootEl.matches('.PostStream'))) return rootEl;

  const byClass =
    rootEl.querySelector('.PostStream') ||
    rootEl.querySelector('.DiscussionPage-list') ||
    rootEl.querySelector('.PostStream-items') ||
    rootEl;

  return byClass;
}

function ensureFlexContainer(container) {
  const cs = container.style;
  if (cs.display !== 'flex') {
    cs.display = 'flex';
    cs.flexDirection = 'column';
  }
  // 允许换行的绝对/固定元素（如锚点）仍然能正确占位
}

function cleanupDepthClasses(node) {
  // 移除所有 thread-depth-* 与我们加的标记类，避免累积
  const toRemove = [];
  node.classList.forEach((c) => {
    if (c.indexOf('thread-depth-') === 0 || c === 'threaded-post' || c === 'thread-deep' || c === 'thread-very-deep' || c === 'thread-root') {
      toRemove.push(c);
    }
  });
  toRemove.forEach((c) => node.classList.remove(c));
}

function collectIds(root) {
  const out = new Set();
  if (!root) return out;
  root.querySelectorAll('article.Post[data-id]').forEach((n) => {
    const id = Number(n.dataset.id);
    if (Number.isFinite(id)) out.add(id);
  });
  return out;
}

function findActivePostStream() {
  // 简单拿第一个 PostStream 组件对应的根 DOM
  const el = document.querySelector('.PostStream') || document.querySelector('article.Post')?.closest('*');
  if (!el) return null;

  // 从 DOM 回溯 mithril 组件实例较复杂；这里用保守方式：遍历 mounted 组件中最可能的那个
  // 在 Flarum 环境下，PostStream 实例通常可从当前页面组件树取到：
  const page = app.current && app.current.get && app.current.get('route') === 'discussion'
    ? app.current.get('component')
    : null;

  // 最稳妥：通过 DiscussionPage 拿到 postStream
  const disc = app.current && app.current.get && app.current.get('discussion');
  if (disc && disc.postStream) return disc.postStream;

  return null;
}

// ============ 轻门帘：避免预取未就绪的短闪动 ============

function tryVeilUntilOrderReady(postStream, did) {
  if (!did) return;

  const root = postStream && postStream.element;
  const container = queryPostContainer(root);
  if (!container) return;

  let unveiled = false;

  const unveil = () => {
    if (unveiled) return;
    unveiled = true;
    container.style.transition = 'opacity 90ms ease';
    container.style.opacity = '1';
  };

  // 先拉低透明度，预取很快的话，看不到闪动；否则最多 VEIL_MAX_WAIT ms
  container.style.opacity = '0';
  const fallback = setTimeout(unveil, VEIL_MAX_WAIT);

  prefetchThreadOrder(did).finally(() => {
    clearTimeout(fallback);
    unveil();
  });
}
