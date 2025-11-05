// js/src/forum/utils/FlexOrderMode.js
//
// “DOM 物理重排模式”（推荐）：
// - 不修改 PostStream 的 posts() 数组；也不写任何 flex/order CSS；
// - 仅在 DOM 层，按 /threads-order 的顺序，把 .PostStream-item[data-id] 重新 insertBefore；
// - 只移动“真实楼层”节点，跳过输入框、typing 指示、加载更多等非帖子节点；
// - 有分页/实时新增时通过 MutationObserver 与 onupdate 触发重排；
// - 不阻断首帧：如果 threads-order 先到则立刻应用，否则也保持时间顺序渲染，待到就绪再在下一帧重排。
// -----------------------------------------------------------------------------

import { extend, override } from 'flarum/common/extend';
import PostStream from 'flarum/forum/components/PostStream';
import PostStreamState from 'flarum/forum/states/PostStreamState';

// 依赖轻量预取：已在你项目中替换为可用版本
import {
  prefetchThreadOrder,
  waitOrderMap,
  hasFreshOrder,
  invalidateThreadOrder,
  getCachedOrderMap,
  getDepthPrefetched,
} from '../utils/ThreadOrderPrefetch';

let suspendApply = false;       // 分页期间暂停应用
let pendingApply = false;       // 分页结束后补一次
let scheduled = 0;              // rAF 句柄
let observer = null;            // MutationObserver
let lastDid = null;             // 当前讨论 id
let lastSig = '';               // 上次已应用的顺序签名（避免重复重排）

export function installFlexOrderMode() {
  // --- Hook 分页：加载前暂停，加载后再应用 ---
  override(PostStreamState.prototype, '_loadPrevious', function (original, ...args) {
    suspendApply = true;
    const p = original(...args);
    return Promise.resolve(p).finally(() => {
      suspendApply = false;
      if (pendingApply) { pendingApply = false; scheduleApplyDOM(); }
    });
  });

  override(PostStreamState.prototype, '_loadNext', function (original, ...args) {
    suspendApply = true;
    const p = original(...args);
    return Promise.resolve(p).finally(() => {
      suspendApply = false;
      if (pendingApply) { pendingApply = false; scheduleApplyDOM(); }
    });
  });

  // --- 生命周期：创建/更新/移除 ---
  extend(PostStream.prototype, 'oncreate', function () {
    const did = getDidFromUrl();
    lastDid = did || null;

    // 预取（不阻断首帧，但数据到达后会触发一次）
    if (did) prefetchThreadOrder(did);

    // 监听 DOM 变化（实时新帖、分页渲染等）
    const container = getContainer();
    if (container) {
      attachObserver(container);
    }

    // 首次排一下（若预取已到）
    scheduleApplyDOM();
  });

  extend(PostStream.prototype, 'onupdate', function () {
    // 有新节点出现或位置变动：排一下
    scheduleApplyDOM();
  });

  extend(PostStream.prototype, 'onremove', function () {
    detachObserver();
    lastSig = '';
  });

  // --- 预取完成事件：threads-order ready 就排 ---
  window.addEventListener('threadify:order-ready', (ev) => {
    const didReady = ev?.detail?.discussionId;
    if (!didReady) return;
    if (Number(didReady) !== Number(getDidFromUrl())) return;
    scheduleApplyDOM();
  });

  // --- 浏览器前进后退 ---
  window.addEventListener('popstate', () => {
    // 讨论切换：重置并尝试预取
    lastSig = '';
    const did = getDidFromUrl();
    lastDid = did || null;
    if (did) prefetchThreadOrder(did);
    scheduleApplyDOM();
  });
}

// ============ DOM 重排主流程 ============

function scheduleApplyDOM() {
  if (suspendApply) { pendingApply = true; return; }
  if (scheduled) cancelAnimationFrame(scheduled);
  scheduled = requestAnimationFrame(async () => {
    try {
      const did = getDidFromUrl();
      if (!did) return;

      // 没缓存或过期 -> 异步等待，一旦有数据立刻排
      if (!hasFreshOrder(did)) {
        await waitOrderMap(did);
      }

      const container = getContainer();
      if (!container) return;

      // 采集“真实楼层”节点区间（跳过非帖子节点）
      const { posts, leftIdx, rightIdx, anchorAfterRange } = collectPostItems(container);
      if (!posts.length) return;

      // 生成排序后的目标序列
      const sorted = sortByPrefetchedOrder(did, posts);

      // 如果已是目标序列，略过
      if (isSameOrder(posts, sorted)) return;

      // 物理重排：逐个 insertBefore 到“帖子段落之后”的锚点之前
      for (const el of sorted) {
        container.insertBefore(el, anchorAfterRange);
      }

      // 记录签名，避免重复
      lastSig = signatureOf(sorted);

      // 可选：为每条帖的 article.Post 添加 thread-depth-* 类（仅视觉用途，不影响 Scrubber）
      tryApplyDepthClasses(did, sorted);
    } catch (e) {
      console.warn('[Threadify] DOM reorder failed:', e);
    }
  });
}

// ============ 辅助：容器/帖子节点收集 ============

function getContainer() {
  // PostStream 根本身即 .PostStream
  const root = document.querySelector('.PostStream');
  return root || null;
}

function collectPostItems(container) {
  const kids = Array.from(container.children || []);
  const isRealPost = (el) =>
    el && el.nodeType === 1 &&
    el.classList?.contains('PostStream-item') &&
    el.hasAttribute('data-id'); // 必须有 data-id 才是“真实楼层”

  let left = -1, right = -1;
  for (let i = 0; i < kids.length; i++) {
    if (isRealPost(kids[i])) { left = i; break; }
  }
  if (left >= 0) {
    for (let j = kids.length - 1; j >= left; j--) {
      if (isRealPost(kids[j])) { right = j; break; }
    }
  }
  const posts = (left >= 0 && right >= left)
    ? kids.slice(left, right + 1).filter(isRealPost)
    : [];

  // “帖子段”的第一个非帖子兄弟作为锚点（插入到它之前）
  const anchorAfterRange = kids[right + 1] || null;

  return { posts, leftIdx: left, rightIdx: right, anchorAfterRange };
}

// ============ 排序与 class 标记 ============

function sortByPrefetchedOrder(did, posts) {
  const BIG = 10_000_000;
  const map = getCachedOrderMap(did) || new Map();

  const arr = posts.slice(); // 拷贝
  arr.sort((a, b) => {
    const ida = +a.dataset.id;
    const idb = +b.dataset.id;
    const oa = map.get(ida)?.order ?? (BIG + ida);
    const ob = map.get(idb)?.order ?? (BIG + idb);
    if (oa === ob) return ida - idb; // 稳定次序
    return oa - ob;
  });
  return arr;
}

function isSameOrder(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function signatureOf(nodes) {
  try {
    return nodes.map((n) => n.dataset.id).join(',');
  } catch {
    return '';
  }
}

function tryApplyDepthClasses(did, postItems) {
  // 为每个 PostStream-item 下的 article.Post 添加 thread-depth-* 类，仅用于视觉缩进
  for (const item of postItems) {
    const id = +item.dataset.id;
    const article = item.querySelector && item.querySelector('article.Post');
    if (!article) continue;

    // 清理旧类
    const toRemove = [];
    article.classList.forEach((c) => {
      if (
        c.indexOf('thread-depth-') === 0 ||
        c === 'threaded-post' || c === 'thread-root' ||
        c === 'thread-deep' || c === 'thread-very-deep'
      ) toRemove.push(c);
    });
    toRemove.forEach((c) => article.classList.remove(c));

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

// ============ Observer ============

function attachObserver(container) {
  detachObserver();
  observer = new MutationObserver((mut) => {
    // 有帖子节点增删时，再排一次（下一帧）
    let touch = false;
    for (const m of mut) {
      if (m.type === 'childList' && (m.addedNodes.length || m.removedNodes.length)) {
        touch = true; break;
      }
    }
    if (touch) scheduleApplyDOM();
  });
  observer.observe(container, { childList: true });
}

function detachObserver() {
  if (observer) {
    try { observer.disconnect(); } catch {}
    observer = null;
  }
}

// ============ 工具：获取讨论 id ============

function getDidFromUrl() {
  // 支持 /d/:id 或 /d/:id/:postNumber 或 /d/:id-:slug
  const segs = (location.pathname || '').split('/').filter(Boolean);
  const i = segs.indexOf('d');
  if (i >= 0 && segs[i + 1]) {
    const m = segs[i + 1].match(/^(\d+)/);
    if (m) return Number(m[1]);
  }
  return null;
}
