// 不改变 PostStream.posts() 也不使用 CSS order；
// 仅在 DOM 中“物理挪动” .PostStream-item[data-id] 节点，
// 保留顶部/底部的非帖子项（加载更多、输入框等）原位，
// 并用 MutationObserver 监听 Realtime/分页变化后 1 帧自动重排。

import { extend } from 'flarum/common/extend';
import PostStream from 'flarum/forum/components/PostStream';

const BIG = 10_000_000;

function getDiscussionIdFromComponent(ps) {
  try {
    return ps?.stream?.discussion?.id?.() ?? null;
  } catch {
    return null;
  }
}

function getContainer(ps) {
  return ps?.element?.querySelector?.('.PostStream') || null;
}

function collectChildren(container) {
  return Array.from(container.children || []);
}

function isPostItem(el) {
  return el && el.matches && el.matches('.PostStream-item[data-id]');
}

// ---- 轻量缓存：did -> { promise, map }
const orderCache = new Map();

function ensureOrderMap(did) {
  const key = String(did);
  const cached = orderCache.get(key);
  if (cached?.map) return Promise.resolve(cached.map);
  if (cached?.promise) return cached.promise.then((e) => e.map);

  const holder = { promise: null, map: null };
  orderCache.set(key, holder);

  holder.promise = app.request({
    method: 'GET',
    url: `${app.forum.attribute('apiUrl')}/discussions/${did}/threads-order`,
  })
    .then((res) => {
      const map = new Map();
      (res.order || []).forEach(({ postId, order, depth, parentPostId }) => {
        map.set(Number(postId), {
          order: Number(order),
          depth: Number.isFinite(depth) ? Number(depth) : 0,
          parentId: parentPostId ? Number(parentPostId) : null,
        });
      });
      holder.map = map;
      return holder;
    })
    .catch((e) => {
      console.warn('[Threadify] threads-order fetch failed', e);
      holder.map = new Map(); // 失败时给空图，返回原序
      return holder;
    });

  return holder.promise.then((e) => e.map);
}

function reorderDOM(container, orderMap) {
  const kids = collectChildren(container);
  if (!kids.length) return;

  // 中间“帖子段” [L, R]，两端的非帖子项保持原位
  let L = kids.findIndex(isPostItem);
  let R = kids.length - 1 - [...kids].reverse().findIndex(isPostItem);
  if (L === -1 || R === -1 || L > R) return;

  const mid = kids.slice(L, R + 1);
  const posts = mid.filter(isPostItem);
  if (!posts.length) return;

  // 目标顺序：threads-order 再按 id 稳定
  const sorted = posts.slice().sort((a, b) => {
    const ida = Number(a.dataset.id);
    const idb = Number(b.dataset.id);
    const ra = orderMap.get(ida);
    const rb = orderMap.get(idb);
    const oa = ra ? ra.order : BIG + ida;
    const ob = rb ? rb.order : BIG + idb;
    return oa === ob ? ida - idb : oa - ob;
  });

  // 已经是正确顺序则不动
  let already = true;
  for (let i = 0; i < posts.length; i++) {
    if (posts[i] !== sorted[i]) { already = false; break; }
  }
  if (already) return;

  // 插入锚点：以“底部段首个节点”为锚（不存在则为 null = 末尾）
  const anchor = kids[R + 1] || null;

  // 物理重排：只移动帖子段内部元素
  for (const el of sorted) {
    container.insertBefore(el, anchor);
  }
}

export function installDomReorderMode() {
  // 给每个 PostStream 实例挂自己的 observer 与一次性重排
  extend(PostStream.prototype, 'oncreate', function () {
    const did = getDiscussionIdFromComponent(this);
    const container = getContainer(this);
    if (!did || !container) return;

    // 第一次：拉取顺序并重排
    ensureOrderMap(did).then((map) => {
      reorderDOM(container, map);
    });

    // 观察子列表变化（Realtime/分页），下一帧重排
    let scheduled = false;
    const observer = new MutationObserver((muts) => {
      if (!muts.some((m) => m.type === 'childList')) return;
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        ensureOrderMap(did).then((map) => reorderDOM(container, map));
      });
    });

    observer.observe(container, { childList: true });
    this.__threadifyDomObserver = observer;
  });

  extend(PostStream.prototype, 'onupdate', function () {
    const did = getDiscussionIdFromComponent(this);
    const container = getContainer(this);
    if (!did || !container) return;
    // 有时 oncreate 之后马上会有一次 patch，这里再确保一次
    ensureOrderMap(did).then((map) => reorderDOM(container, map));
  });

  extend(PostStream.prototype, 'onremove', function () {
    if (this.__threadifyDomObserver) {
      try { this.__threadifyDomObserver.disconnect(); } catch {}
      this.__threadifyDomObserver = null;
    }
  });
}
