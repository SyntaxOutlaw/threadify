// “Flex 排序模式”：不改 PostStream 的 posts() 顺序；
// 仅在 DOM 层对每个 .PostStream-item[data-id] 设置 CSS order，
// 并据预取的深度为其内部 article.Post 打上 thread-depth-* 类名。
// 分页（_loadPrevious/_loadNext）时自动暂停应用，结束后再批量应用。
// 新回复出现时自动刷新预取并重排。
// 附带“轻门帘”：预取未就绪时把 Post 容器临时设为透明，避免短暂未排序闪动。

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
    // 轻门帘：预取很快的话看不到；慢了最多 VEIL_MAX_WAIT ms
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
      prefetchThreadOrder(did, { force: true }).finally(() => scheduleApply(this));
    } else {
      scheduleApply(this);
    }
  });

  // 当预取完成时（任意来源触发），如果正处在相同讨论页，则立即应用
  window.addEventListener('threadify:order-ready', (ev) => {
    const didReady = ev && ev.detail && ev.detail.discussionId;
    if (!didReady) return;
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

  // 找到 Post 容器（.PostStream）并加上 flex 类
  const container = queryPostContainer(root);
  if (!container) return;
  container.classList.add('threadify-flex');

  const did = postStream.stream && postStream.stream.discussion && postStream.stream.discussion.id();

  // ① 先把“非帖子子项”拉到底（TypingUsers / 无 data-id 的占位项）
  container.querySelectorAll('.TypingUsersContainer, .PostStream-item:not([data-id])')
    .forEach(el => { el.style.order = '2147483600'; });

  // ② 正式给帖子排序：真正的 flex 子项是 .PostStream-item[data-id]
  const items = Array.from(container.querySelectorAll('.PostStream-item[data-id]'));

  // 更新 seenIds
  items.forEach((n) => { const id = Number(n.getAttribute('data-id')); if (Number.isFinite(id)) seenIds.add(id); });

  items.forEach((item) => {
    const id = Number(item.getAttribute('data-id'));
    if (!Number.isFinite(id)) return;

    const order = getOrderIndex(did, id);
    const ord = Number.isInteger(order) ? order : 10_000_000 + id; // 未命中顺序给很靠后 fallback
    item.style.order = String(ord);

    // 深度类：打在内部 article.Post 上（更合理）
    const article = item.querySelector('article.Post');
    if (article) {
      cleanupDepthClasses(article);
      const depth = getDepthPrefetched(did, id);
      if (Number.isFinite(depth) && depth > 0) {
        article.classList.add('threaded-post', `thread-depth-${Math.min(depth, 10)}`);
        if (depth >= 3) article.classList.add('thread-deep');
        if (depth >= 5) article.classList.add('thread-very-deep');
      } else {
        article.classList.add('thread-root');
      }
    }
  });
}

// ============ 工具函数 ============

function queryPostContainer(rootEl) {
  if (!rootEl) return null;
  if (rootEl.classList && (rootEl.classList.contains('PostStream') || rootEl.matches('.PostStream'))) return rootEl;
  return rootEl.querySelector('.PostStream') || rootEl.querySelector('.DiscussionPage-list') || rootEl;
}

function cleanupDepthClasses(node) {
  const toRemove = [];
  node.classList.forEach((c) => {
    if (
      c.indexOf('thread-depth-') === 0 ||
      c === 'threaded-post' ||
      c === 'thread-deep' ||
      c === 'thread-very-deep' ||
      c === 'thread-root'
    ) {
      toRemove.push(c);
    }
  });
  toRemove.forEach((c) => node.classList.remove(c));
}

function collectIds(root) {
  const out = new Set();
  if (!root) return out;
  root.querySelectorAll('.PostStream-item[data-id]').forEach((n) => {
    const id = Number(n.getAttribute('data-id'));
    if (Number.isFinite(id)) out.add(id);
  });
  return out;
}

function findActivePostStream() {
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

  // 先拉低透明度，预取很快的话看不到闪动；否则最多 VEIL_MAX_WAIT ms
  container.style.opacity = '0';
  // 开始预取
  const fallback = setTimeout(unveil, VEIL_MAX_WAIT);
  prefetchThreadOrder(did).finally(() => {
    clearTimeout(fallback);
    unveil();
  });
}
