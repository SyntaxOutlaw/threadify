// js/src/forum/components/ThreadedPostStream.js
// -------------------------------------------------------------
// Threaded PostStream Component (stable, no first-frame reorder)
// 修复重点：
// 1) 分页加载（loading*）期间严禁改动 posts 顺序，避免 anchorScroll 锚点丢失。
// 2) 不使用 null 作为占位，改为 undefined，避免 Mithril 读取 vnode.tag 报错。
// 3) 预取/改排完成后的 redraw 仅在非加载期触发，减少与 anchorScroll 竞争。
// -------------------------------------------------------------


import app from 'flarum/forum/app';
import { extend } from 'flarum/common/extend';
import PostStream from 'flarum/forum/components/PostStream';
import PostStreamState from 'flarum/forum/states/PostStreamState';


import { createThreadedPosts } from '../utils/ThreadTree';
import { clearThreadDepthCache } from '../utils/ThreadDepth';
import { loadMissingParentPosts, loadMinimalChildren } from '../utils/PostLoader';
import { getOrderIndex, prefetchThreadOrder } from '../utils/ThreadOrderPrefetch';


// ----- 模块级状态 -----
let isReordering = false;
let reorderedPostsCache = null; // 线程化后的 posts（含 undefined 占位）
let lastPostCount = 0;
let originalPostsMethod = null; // 保存 PostStream 的原始 posts()
let currentDiscussionId = null;
let threadedOrder = null; // Map<postId, order>
let enableMinimalChildLoading = true;


// 工具：判断 PostStreamState 是否处于加载中（上一页/下一页/邻近锚点）
function isStreamBusy(state) {
if (!state) return false;
try {
return Object.keys(state).some((k) => /^loading/i.test(k) && !!state[k]);
} catch (e) {
return !!(state.loadingPrevious || state.loadingNext || state.loadingNear || state.loading);
}
}


// ===================================================================
// 初始化：挂接 PostStream 生命周期 & PostStreamState.visiblePosts
// ===================================================================
export function initThreadedPostStream() {
// 首次初始化 & 讨论切换
extend(PostStream.prototype, 'oninit', function () {
const did = this.stream.discussion && this.stream.discussion.id && this.stream.discussion.id();
if (currentDiscussionId !== did) resetState(did);


if (!originalPostsMethod) originalPostsMethod = this.stream.posts;


// 预取讨论的线程顺序（payload 很小）
if (did) prefetchThreadOrder(did);


// 覆写 posts：加载期返回原始顺序，否则若有缓存则返回缓存
this.stream.posts = () => {
if (isStreamBusy(this.stream)) {
return (originalPostsMethod && originalPostsMethod.call(this.stream)) || [];
}
if (reorderedPostsCache) return reorderedPostsCache;


const original = (originalPostsMethod && originalPostsMethod.call(this.stream)) || [];
if (!isReordering && original.filter(Boolean).length > 0) {
updateReorderedCache(this /* first kick */);
}
return original;
};


// 记录首屏帖子数，并尝试异步构建缓存
const cur = (originalPostsMethod && originalPostsMethod.call(this.stream)) || [];
lastPostCount = cur.filter(Boolean).length;
if (lastPostCount > 0) updateReorderedCache(this);
});


// “可见列表”排序：只在不加载时、且两边都是 Post 时才比较
extend(PostStreamState.prototype, 'visiblePosts', function (result) {
if (!Array.isArray(result) || result.length <= 1) return result;


// 正在加载上一页/下一页/附近锚点时，不做任何重排，避免 anchorScroll 取不到 DOM
if (isStreamBusy(this)) return result;
}
