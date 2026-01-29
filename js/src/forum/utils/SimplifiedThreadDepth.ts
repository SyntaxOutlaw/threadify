import app from 'flarum/forum/app';
import { getDepthPrefetched } from './ThreadOrderPrefetch';

const MAX_DISPLAY_DEPTH = 10;

interface Post {
  id(): number;
  discussion(): { id(): number } | null;
  attribute(name: string): unknown;
}

function clampDepth(n: number): number {
  const x = Number(n);
  return Number.isFinite(x) ? Math.max(0, Math.min(MAX_DISPLAY_DEPTH, x)) : 0;
}

function walkDepthByParentChain(post: Post): number {
  let depth = 0;
  let guard = 0;
  const seen = new Set<number>();

  let current: Post | null = post;
  while (current && guard < 100) {
    const pid = current.attribute('parent_id') as number | null;
    if (!pid) break;

    if (seen.has(pid)) {
      console.warn('[Threadify] cycle detected while walking parents of', post?.id?.());
      depth = 0;
      break;
    }
    seen.add(pid);

    depth += 1;
    const parent = app.store.getById<Post>('posts', String(pid));
    if (!parent) break;

    current = parent;
    guard++;
    if (depth >= MAX_DISPLAY_DEPTH) break;
  }
  return clampDepth(depth);
}

export function getThreadDepth(post: Post | null | undefined): number {
  if (!post || typeof post.id !== 'function') return 0;

  try {
    const discussion = post.discussion?.();
    const did = discussion?.id?.() ?? null;
    if (did != null) {
      const d = getDepthPrefetched(did, post.id());
      if (Number.isInteger(d)) return clampDepth(d!);
    }
  } catch {
    // ignore
  }

  return walkDepthByParentChain(post);
}

export function getThreadCssClasses(post: Post | null | undefined): string[] {
  const depth = getThreadDepth(post);
  const classes: string[] = [];

  if (depth > 0) {
    classes.push('threaded-post');
    classes.push(`thread-depth-${depth}`);
    if (depth >= 3) classes.push('thread-deep');
    if (depth >= 5) classes.push('thread-very-deep');
  } else {
    classes.push('thread-root');
  }

  return classes;
}

export function isRootPost(post: Post | null | undefined): boolean {
  return getThreadDepth(post) === 0;
}
