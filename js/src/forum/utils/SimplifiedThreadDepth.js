/**
 * Simplified Thread Depth Utilities (fixed)
 *
 * 优先级：
 *  1) /threads-order 预取的 depth
 *  2) /threads 元数据里的 _threadDepth
 *  3) 本地沿 parent_id 向上爬链计算
 *
 * 始终返回 0..MAX_DISPLAY_DEPTH，且不会抛错。
 */

import { getPostThreadMetadata } from './ThreadsApi';
import { getDepthPrefetched, getParentPrefetched } from './ThreadOrderPrefetch';

const MAX_DISPLAY_DEPTH = 10;

/** ---- helpers ---- */
function clampDepth(n) {
  const x = Number(n);
  return Number.isFinite(x) ? Math.max(0, Math.min(MAX_DISPLAY_DEPTH, x)) : 0;
}

function walkDepthByParentChain(post) {
  // 沿 parent_id 向上爬；即便父帖未加载也能给出“已知最大深度”
  let depth = 0;
  let guard = 0;
  const seen = new Set();

  let current = post;
  while (current && guard < 100) {
    const pid = current.attribute ? current.attribute('parent_id') : null;
    if (!pid) break;

    // 循环保护
    if (seen.has(pid)) {
      console.warn('[Threadify] cycle detected while walking parents of', post && post.id && post.id());
      depth = 0;
      break;
    }
    seen.add(pid);

    depth += 1;
    // 试着从 store 取父贴，取不到就以当前深度作准（父贴可能尚未加载）
    const parent = app.store.getById('posts', String(pid));
    if (!parent) break;

    current = parent;
    guard++;
    if (depth >= MAX_DISPLAY_DEPTH) break;
  }
  return clampDepth(depth);
}

/** ---- public API ---- */

/**
 * Get thread depth for a post (0=root)
 */
export function getThreadDepth(post) {
  if (!post || typeof post.id !== 'function') return 0;

  // 1) 预取顺序里的 depth（最快、最稳定）
  try {
    const did =
      (post.discussion && typeof post.discussion === 'function' && post.discussion() && post.discussion().id && post.discussion().id()) ||
      null;
    if (did != null) {
      const d = getDepthPrefetched(did, post.id());
      if (Number.isInteger(d)) return clampDepth(d);
    }
  } catch (_) {
    // ignore
  }

  // 2) /threads 元数据（若前端曾调用过 loadDiscussionThreads）
  try {
    const md = getPostThreadMetadata(post);
    if (md && Number.isInteger(md.depth)) return clampDepth(md.depth);
  } catch (_) {
    // ignore
  }

  // 3) 本地按 parent_id 向上爬链
  return walkDepthByParentChain(post);
}

/**
 * CSS classes for a post based on its thread depth.
 * 统一使用：threaded-post / thread-root / thread-depth-N / thread-deep / thread-very-deep
 */
export function getThreadCssClasses(post) {
  const depth = getThreadDepth(post);
  const classes = [];

  if (depth > 0) {
    classes.push('threaded-post');
    classes.push(`thread-depth-${depth}`);
    if (depth >= 3) classes.push('thread-deep');
    if (depth >= 5) classes.push('thread-very-deep');
  } else {
    classes.push('thread-root');
  }

  // 尽量从预取或元数据补充“根/父”信息（可选）
  try {
    const did =
      (post.discussion && typeof post.discussion === 'function' && post.discussion() && post.discussion().id && post.discussion().id()) ||
      null;
    const prefParent = did != null ? getParentPrefetched(did, post.id()) : undefined;
    const md = getPostThreadMetadata(post);

    const isRoot =
      (prefParent === null || prefParent === undefined) ?
        (!post.attribute || !post.attribute('parent_id')) :
        (prefParent == null);

    if (isRoot) classes.push('thread-root-confirmed');

    // 可根据 md.childCount / md.descendantCount 再加细化类名（没有就跳过）
    if (md && Number.isInteger(md.childCount) && md.childCount > 0) {
      classes.push('has-children', `child-count-${Math.min(md.childCount, 10)}`);
    }
    if (md && Number.isInteger(md.descendantCount) && md.descendantCount > 0) {
      classes.push('has-descendants');
    }
  } catch (_) {
    // 忽略补充信息失败
  }

  return classes;
}

/** convenience helpers */
export function isRootPost(post) {
  return getThreadDepth(post) === 0;
}

export function getThreadRootId(/* post */) {
  // 若后续需要，可接入预取 map 里的 rootId；当前仅用于样式则不强制实现
  return null;
}

export function getChildCount(post) {
  const md = getPostThreadMetadata(post);
  return md && Number.isInteger(md.childCount) ? md.childCount : 0;
}

export function getDescendantCount(post) {
  const md = getPostThreadMetadata(post);
  return md && Number.isInteger(md.descendantCount) ? md.descendantCount : 0;
}

export function getThreadPath(post) {
  const md = getPostThreadMetadata(post);
  return md ? md.threadPath || null : null;
}
