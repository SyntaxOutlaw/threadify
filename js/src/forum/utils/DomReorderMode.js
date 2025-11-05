// js/src/forum/utils/DomReorderMode.js
// 物理重排 .PostStream-item[data-id]（仅限当前已挂载的“同一窗口”内）
// 目标：保证 Scrubber/地址栏楼层号正常；不跨窗口硬搬，避免被 PostStream 回收导致“消失”。
// 依赖统一复用 ThreadOrderPrefetch 的缓存，去除本文件冗余缓存。
// 修复：insertBefore 报错（anchor 非 container 子节点）——插入前二次校验并降级为 appendChild。

import app from 'flarum/forum/app';
import { extend } from 'flarum/common/extend';
import PostStream from 'flarum/forum/components/PostStream';
import {
  waitOrderMap,
  hasFreshOrder,
  prefetchThreadOrder,
} from '../utils/ThreadOrderPrefetch';

const BIG = 10_000_000; // 未收录帖子排序兜底的高权重
const LOG_NS = '[Threadify]';

function getDidFromComponent(ps) {
  try {
    return ps?.stream?.discussion?.id?.() ?? null;
  } catch {
    return null;
  }
}

function getContainer(ps) {
  // 1) 本组件根就是 .PostStream
  if (ps?.element?.classList?.contains('PostStream')) return ps.element;
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

function sortByOrderMap(nodes, orderMap) {
  const arr = nodes.slice();
  arr.sort((a, b) => {
    const ida = Number(a.dataset.id);
    const idb = Number(b.dataset.id);
    const ra = orderMap.get(ida);
    const rb = orderMap.get(idb);
    const oa = ra ? ra.order : BIG + ida;
    const ob = rb ? rb.order : BIG + idb;
    return oa === ob ? ida - idb : oa - ob;
  });
  return arr;
}

function sameOrder(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * 取“当前容器里连续的帖子段”与其尾部之后的第一个兄弟节点（作为 anchor）。
 * 说明：
 * - 我们只对“当前已挂载的 DOM”做排序（= 同一窗口内重排）。
 * - 返回的 anchor 可能在后续一帧被窗口化逻辑移除，所以插入前还要二次校验。
 */
function findPostsRange(container) {
  const kids = collectChildren(container);
  if (!kids.length) return { posts: [], left: -1, right: -1, anchor: null };

  let L = kids.findIndex(isPostItem);
  if (L < 0) return { posts: [], left: -1, right: -1, anchor: kids[0] || null };

  let R = kids.length - 1 - [...kids].reverse().findIndex(isPostItem);
  if (R < L) R = L;

  const posts = kids.slice(L, R + 1).filter(isPostItem);
  const anchor = kids[R + 1] || null; // 计划插在“帖子段”之后的第一个兄弟之前
  return { posts, left: L, right: R, anchor };
}

function datasetIds(nodes) {
  try {
    return nodes.map((n) => Number(n.dataset.id));
  } catch {
    return [];
  }
}

/**
 * 仅在“同一 PostStream 容器（=当前窗口已加载）”内做 DOM 重排。
 * 若发现当前 DOM 中存在不在顺序表里的帖子，并且缓存已不新鲜，则强刷一次。
 */
async function reorderWithinWindow(container, did) {
  const firstMap = await waitOrderMap(did);
  const { posts, anchor } = findPostsRange(container);
  if (!posts.length) return;

  // 检查是否存在“DOM 里有而顺序表里没有”的帖子
  const domIds = datasetIds(posts);
  const missing = domIds.some((id) => !firstMap.has(id));

  let orderMap = firstMap;
  if (missing && !hasFreshOrder(did)) {
    // 强刷一次，避免排序抖动（只强刷一轮）
    await prefetchThreadOrder(did, { force: true });
    orderMap = await waitOrderMap(did);
  }

  // 只对“当前窗口已加载”的这些 posts 排序（不跨窗口搬运）
  doSafeReorder(container, posts, anchor, orderMap);
}

/**
 * 稳健插入：插入前校验 anchor 是否仍为 container 子节点；
 * 若 anchor 已失效，则降级为 append（等价于 insertBefore(el, null)）。
 * 同时，逐个元素检查 el 仍在 container 中（可能已被窗口化卸载）。
 */
function doSafeReorder(container, posts, anchor, orderMap) {
  if (!container) return;

  // 快照，避免排序中又触发 observer 导致二次排序
  const snapshot = posts.filter((el) => el && el.parentNode === container);
  if (!snapshot.length) return;

  const sorted = sortByOrderMap(snapshot, orderMap);
  if (sameOrder(snapshot, sorted)) return;

  const ref =
    anchor && anchor.parentNode === container ? anchor : null;

  for (const el of sorted) {
    if (el.parentNode !== container) continue; // 已被卸载，跳过
    try {
      container.insertBefore(el, ref);
    } catch (e) {
      // 常见于 anchor/ref 在这一次循环中发生了变化；降级为 append 再试一次
      try {
        container.insertBefore(el, null);
      } catch (err) {
        // 仍失败则记录一次日志并跳过该元素
        // 利用 threadifyLogs 开关抑制输出
        console.warn(`${LOG_NS} insertBefore failed for #${el.dataset?.id}`, err);
      }
    }
  }
}

/** 安装“只在同窗内重排”的模式 */
export function installDomReorderMode() {
  extend(PostStream.prototype, 'oncreate', function () {
    const did = getDidFromComponent(this);
    const container = getContainer(this);
    if (!did || !container) return;

    // 控制台测试钩子：验证两帖是否“同窗”（=都在当前容器内）
    // 用法：threadifyTest.sameWindow(94, 3580)
    window.threadifyTest = window.threadifyTest || {};
    window.threadifyTest.sameWindow = (a, b) => {
      const qa = container.querySelector(`.PostStream-item[data-id="${Number(a)}"]`);
      const qb = container.querySelector(`.PostStream-item[data-id="${Number(b)}"]`);
      return !!(qa && qb);
    };

    // 首次重排（仅对已加载的窗口）
    reorderWithinWindow(container, did);

    // 监听“窗口化加载/卸载”引起的子节点变化；合并到下一帧重排
    let scheduled = false;
    const observer = new MutationObserver((muts) => {
      if (!muts.some((m) => m.type === 'childList')) return;
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        reorderWithinWindow(container, did);
      });
    });

    observer.observe(container, { childList: true });
    this.__threadifyDomObserver = observer;
  });

  extend(PostStream.prototype, 'onupdate', function () {
    const did = getDidFromComponent(this);
    const container = getContainer(this);
    if (!did || !container) return;
    // 更新时也做一次“同窗内重排”
    reorderWithinWindow(container, did);
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
