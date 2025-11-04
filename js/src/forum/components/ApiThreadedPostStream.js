/**
 * 基于 threads-order 的 PostStream 重排
 * - 不改动 PostStreamState 的分页逻辑（保留 null 空洞）
 * - 仅对“已加载的连续区段”做线程顺序重排
 * - 发现帖子数量变化 => 重新预取并重排（兼容 Realtime）
 */

import { extend } from 'flarum/common/extend';
import PostStream from 'flarum/forum/components/PostStream';
import { prefetchThreadsOrder, hasOrderFor, getOrderRecord } from '../utils/ThreadsApi';

let currentDid = null;
let cached = null;         // 上一次重排后的数组（含 null）
let lastCount = -1;        // 上一次非空帖子数量
let originalGetter = null; // 暂存原始 posts() 读取

export function installApiThreadedPostStream() {
  // 记录原始 getter，并包裹返回值
  extend(PostStream.prototype, 'oninit', function () {
    if (!originalGetter) originalGetter = this.stream.posts;
  });

  // 讨论切换时清理缓存并预取
  extend(PostStream.prototype, 'oncreate', function () {
    const did = this.stream && this.stream.discussion && this.stream.discussion.id();
    if (did && did !== currentDid) {
      currentDid = did;
      cached = null;
      lastCount = -1;
      prefetchThreadsOrder(did);
    }
    // 首帧就尝试构建缓存，避免“轻微闪动”
    buildCacheIfNeeded(this);
  });

  // 任何更新都尝试重建（含 Realtime 新增）
  extend(PostStream.prototype, 'onupdate', function () {
    buildCacheIfNeeded(this);
  });

  // 最关键：用我们自己的缓存作为 posts() 的返回值
  extend(PostStream.prototype, 'posts', function (ret) {
    if (cached && currentDid === (this.stream && this.stream.discussion && this.stream.discussion.id())) {
      return cached;
    }
    // 兜底：还没准备好时返回原始数组
    return ret();
  });
}

/** 内部：在需要时重建缓存 */
function buildCacheIfNeeded(ps) {
  if (!ps || !originalGetter) return;

  const did = ps.stream && ps.stream.discussion && ps.stream.discussion.id();
  if (!did) return;

  const raw = originalGetter.call(ps.stream);
  if (!raw || !raw.length) { cached = raw; return; }

  // 统计当前已加载的帖子数量
  const loaded = raw.filter((x) => !!x);
  const loadedCount = loaded.length;

  // 没有顺序数据时，先去预取；等下一轮 update 再用
  if (!hasOrderFor(did)) {
    prefetchThreadsOrder(did).finally(() => { /* 触发下一轮 onupdate 即可 */ });
    cached = raw;
    lastCount = loadedCount;
    return;
  }

  // 数量或讨论变了，或者还没有缓存 => 重排
  if (!cached || loadedCount !== lastCount) {
    cached = reorderWithinLoadedSegment(raw, did);
    lastCount = loadedCount;
  }
}

/**
 * 只在“已加载的连续区段”里做重排；保留前后 null 空洞与长度
 */
function reorderWithinLoadedSegment(originalArr, discussionId) {
  const arr = originalArr.slice();

  // 找到连续区段 [L, R]
  let L = 0, R = arr.length - 1;
  while (L < arr.length && !arr[L]) L++;
  while (R >= 0 && !arr[R]) R--;
  if (L > R) return arr; // 全是空

  // 取出连续区段的帖子，按 threads-order 的 order 排序
  const segment = arr.slice(L, R + 1).filter(Boolean);

  segment.sort((a, b) => {
    const ra = getOrderRecord(discussionId, a.id());
    const rb = getOrderRecord(discussionId, b.id());
    const oa = ra ? ra.order : Number.MAX_SAFE_INTEGER;
    const ob = rb ? rb.order : Number.MAX_SAFE_INTEGER;
    // 稳定排序：order 相等时按 post id
    if (oa === ob) return a.id() - b.id();
    return oa - ob;
  });

  // 回填：保持两端的 null 不动，只替换中段的非空位
  const result = arr.slice();
  let p = 0;
  for (let i = L; i <= R; i++) {
    if (result[i]) {
      result[i] = segment[p++] || result[i];
    }
  }
  return result;
}
