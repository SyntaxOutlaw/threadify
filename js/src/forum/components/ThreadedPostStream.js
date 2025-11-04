// js/src/forum/components/ThreadedPostStream.js
import app from 'flarum/forum/app';
import { extend, override } from 'flarum/common/extend';
import PostStreamState from 'flarum/forum/states/PostStreamState';
import PostStream from 'flarum/forum/components/PostStream';

import { prefetchThreadOrder, getOrderIndex } from '../utils/ThreadOrderPrefetch';

/**
 * 仅做“可见列表”层面的稳定排序：
 * - 不覆盖 this.stream.posts（保留楼层号/分页锚点的不变量）
 * - 不在分页进行中排序，避免 anchorScroll 取不到锚点
 * - 返回新数组，不原地 sort
 */

let pagingDepth = 0; // >0 表示正在分页装载（上一页/下一页）

export function initThreadedPostStream() {
  // 讨论切换时，尝试预取顺序（极轻量）
  extend(PostStream.prototype, 'oninit', function () {
    const did = this.stream && this.stream.discussion && this.stream.discussion.id();
    if (did) prefetchThreadOrder(did);
  });

  // 包一层：分页开始/结束时标记状态
  override(PostStreamState.prototype, '_loadPrevious', function (original, ...args) {
    pagingDepth++;
    const p = original(...args);
    return Promise.resolve(p).finally(() => {
      pagingDepth = Math.max(0, pagingDepth - 1);
    });
  });

  override(PostStreamState.prototype, '_loadNext', function (original, ...args) {
    pagingDepth++;
    const p = original(...args);
    return Promise.resolve(p).finally(() => {
      pagingDepth = Math.max(0, pagingDepth - 1);
    });
  });

  // 只对“可见列表”排序；分页时直接返回原结果
  extend(PostStreamState.prototype, 'visiblePosts', function (result) {
    if (!Array.isArray(result) || result.length <= 1) return result;
    if (pagingDepth > 0) return result; // 正在分页，避免打断锚点

    const did = this.discussion && this.discussion.id && this.discussion.id();

    // 复制一份，保持纯函数
    const out = result.slice();

    // 使用预取顺序排序；没有顺序信息时保持原相对顺序
    out.sort((a, b) => {
      const aid = a && a.id ? a.id() : null;
      const bid = b && b.id ? b.id() : null;
      if (!aid || !bid) return 0;

      const ao = getOrderIndex(did, aid);
      const bo = getOrderIndex(did, bid);

      if (ao == null && bo == null) return 0; // 两个都没有记录：不动
      if (ao == null) return 1;               // 有记录的优先
      if (bo == null) return -1;

      // 都有记录：按 threads-order 升序
      return ao - bo;
    });

    return out;
  });
}
