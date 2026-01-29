import app from 'flarum/forum/app';
import { extend } from 'flarum/common/extend';
import PostStream from 'flarum/forum/components/PostStream';
import {
  waitOrderMap,
  prefetchThreadOrder,
  invalidateThreadOrder,
} from './ThreadOrderPrefetch';
import { getThreadDepth } from './SimplifiedThreadDepth';

declare const m: { redraw(): void };

interface OrderRecord {
  order: number;
  depth: number;
  parentId: number | null;
}

interface PostModel {
  id(): number;
  number?(): number;
  createdAt?(): Date;
  contentType?(): string;
  attribute?(name: string): unknown;
}

interface PostStreamComponent {
  stream?: {
    discussion?: {
      id(): number;
    };
  };
  element?: HTMLElement;
  __threadifyDomObserver?: MutationObserver;
}

const BIG = 10_000_000;

let redrawScheduled = false;
function scheduleRedraw(): void {
  if (redrawScheduled) return;
  redrawScheduled = true;
  try {
    requestAnimationFrame(() => {
      redrawScheduled = false;
      if (typeof m === 'object' && typeof m.redraw === 'function') m.redraw();
    });
  } catch {
    redrawScheduled = false;
  }
}

function getDidFromComponent(ps: PostStreamComponent): number | null {
  try {
    return ps?.stream?.discussion?.id?.() ?? null;
  } catch {
    return null;
  }
}

function getContainer(ps: PostStreamComponent): HTMLElement | null {
  if (ps?.element?.classList?.contains('PostStream')) return ps.element;
  return ps?.element?.querySelector?.('.PostStream') || document.querySelector('.PostStream') || null;
}

function isPostItem(el: Element): el is HTMLElement {
  return el?.nodeType === 1 && el.matches('.PostStream-item[data-id]');
}

function findPostsRange(container: HTMLElement | null): { posts: HTMLElement[]; anchor: HTMLElement | null } {
  const kids = Array.from(container?.children || []) as HTMLElement[];
  if (!kids.length) return { posts: [], anchor: null };
  let L = kids.findIndex(isPostItem);
  if (L < 0) return { posts: [], anchor: kids[0] || null };
  let R = kids.length - 1 - [...kids].reverse().findIndex(isPostItem);
  if (R < L) R = L;
  const posts = kids.slice(L, R + 1).filter(isPostItem);
  const anchor = kids[R + 1] || null;
  return { posts, anchor };
}

function sameOrder(a: HTMLElement[], b: HTMLElement[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function getModel(id: number): PostModel | null {
  try {
    return app.store.getById('posts', String(id)) as PostModel | null;
  } catch {
    return null;
  }
}

function getNumber(model: PostModel | null): number | null {
  try {
    const n = model?.number?.();
    return Number.isFinite(n) ? n! : null;
  } catch {
    return null;
  }
}

function getCreatedTs(model: PostModel | null): number | null {
  try {
    const d = model?.createdAt?.();
    return d instanceof Date ? +d : null;
  } catch {
    return null;
  }
}

function getContentType(model: PostModel | null): string | null {
  try {
    if (!model) return null;
    if (typeof model.contentType === 'function') return model.contentType();
    if (typeof model.attribute === 'function') return (model.attribute('contentType') as string) ?? null;
  } catch {
    // ignore
  }
  return null;
}

function isEventPostByEl(el: HTMLElement, model: PostModel | null): boolean {
  const ct = getContentType(model);
  if (ct && ct !== 'comment') return true;
  if (el?.classList?.contains('EventPost') || el?.classList?.contains('Post-event')) return true;
  if (el?.querySelector?.('.EventPost, .Post-event, .EventPost-icon')) return true;
  return false;
}

function orderKey(orderRec: OrderRecord | undefined, model: PostModel | null, id: number): number {
  if (orderRec && Number.isFinite(orderRec.order)) return Number(orderRec.order);
  const n = getNumber(model);
  if (n != null) return n;
  const t = getCreatedTs(model);
  if (t != null) return BIG / 2 + t;
  return BIG + Number(id);
}

function linearKey(model: PostModel | null, id: number): number {
  const t = getCreatedTs(model);
  if (t != null) return t;
  const n = getNumber(model);
  if (n != null) return BIG / 2 + n;
  return BIG + Number(id);
}

interface EligibilityResult {
  eligible: Set<number>;
  events: Set<number>;
  models: Map<number, PostModel | null>;
  parentOf: Map<number, number | null>;
  present: Set<number>;
}

function computeEligibility(posts: HTMLElement[], orderMap: Map<number, OrderRecord>): EligibilityResult {
  const present = new Set(posts.map((el) => Number(el.dataset.id)));
  const models = new Map<number, PostModel | null>(
    posts.map((el) => [Number(el.dataset.id), getModel(Number(el.dataset.id))])
  );

  const parentOf = new Map<number, number | null>();
  for (const el of posts) {
    const id = Number(el.dataset.id);
    const rec = orderMap.get(id);
    const m = models.get(id);
    const pid = rec ? rec.parentId : (m?.attribute?.('parent_id') as number | null);
    parentOf.set(id, pid == null ? null : Number(pid));
  }

  const events = new Set<number>();
  for (const el of posts) {
    const id = Number(el.dataset.id);
    if (isEventPostByEl(el, models.get(id)!)) events.add(id);
  }

  const eligible = new Set<number>();
  for (const el of posts) {
    const id = Number(el.dataset.id);
    if (events.has(id)) continue;
    if (parentOf.get(id) == null) eligible.add(id);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const el of posts) {
      const id = Number(el.dataset.id);
      if (eligible.has(id) || events.has(id)) continue;
      const pid = parentOf.get(id);
      if (pid == null) continue;
      if (!present.has(pid)) continue;
      if (!eligible.has(pid)) continue;
      eligible.add(id);
      changed = true;
    }
  }

  return { eligible, events, models, parentOf, present };
}

function buildBaseTarget(
  posts: HTMLElement[],
  eligible: Set<number>,
  events: Set<number>,
  orderMap: Map<number, OrderRecord>,
  models: Map<number, PostModel | null>
): HTMLElement[] {
  const eligList = posts.filter((el) => eligible.has(Number(el.dataset.id)));
  const sortedElig = eligList.slice().sort((a, b) => {
    const ida = Number(a.dataset.id);
    const idb = Number(b.dataset.id);
    const ka = orderKey(orderMap.get(ida), models.get(ida)!, ida);
    const kb = orderKey(orderMap.get(idb), models.get(idb)!, idb);
    return ka === kb ? ida - idb : ka - kb;
  });

  const base: HTMLElement[] = [];
  let j = 0;
  for (const el of posts) {
    const id = Number(el.dataset.id);
    base.push(eligible.has(id) ? sortedElig[j++] : el);
  }

  const withoutEvents = base.filter((el) => !events.has(Number(el.dataset.id)));
  const evtList = posts
    .filter((el) => events.has(Number(el.dataset.id)))
    .sort((a, b) => {
      const ida = Number(a.dataset.id);
      const idb = Number(b.dataset.id);
      const ka = linearKey(models.get(ida)!, ida);
      const kb = linearKey(models.get(idb)!, idb);
      return ka === kb ? ida - idb : ka - kb;
    });

  const out = withoutEvents.slice();
  const commentKey = (el: HTMLElement) => linearKey(models.get(Number(el.dataset.id))!, Number(el.dataset.id));

  for (const evEl of evtList) {
    const eid = Number(evEl.dataset.id);
    const ek = linearKey(models.get(eid)!, eid);
    let insertAt = -1;
    for (let i = 0; i < out.length; i++) {
      if (commentKey(out[i]) > ek) {
        insertAt = i;
        break;
      }
    }
    if (insertAt === -1) out.push(evEl);
    else out.splice(insertAt, 0, evEl);
  }

  return out;
}

function applyLockedCohesion(
  sequence: HTMLElement[],
  eligible: Set<number>,
  events: Set<number>,
  models: Map<number, PostModel | null>,
  parentOf: Map<number, number | null>
): HTMLElement[] {
  const presentIds = sequence.map((el) => Number(el.dataset.id));
  const present = new Set(presentIds);
  const locked = new Set(presentIds.filter((id) => !events.has(id) && !eligible.has(id)));
  if (!locked.size) return sequence;

  function nearestVisibleLockedAncestor(id: number): number | null {
    let cur = id;
    for (let g = 0; g < 100; g++) {
      const pid = parentOf.get(cur);
      if (pid == null) return null;
      if (!present.has(pid)) return null;
      if (locked.has(pid)) return pid;
      cur = pid;
    }
    return null;
  }

  const groups = new Map<number, Set<number>>();
  for (const id of locked) {
    const root = nearestVisibleLockedAncestor(id);
    if (root == null || root === id) continue;
    if (!groups.has(root)) groups.set(root, new Set());
    groups.get(root)!.add(id);
  }
  if (!groups.size) return sequence;

  const out = sequence.slice();
  const indexOfId = new Map(out.map((el, idx) => [Number(el.dataset.id), idx]));
  const sortedRoots = Array.from(groups.keys()).sort((a, b) => indexOfId.get(a)! - indexOfId.get(b)!);

  function extractMembers(ids: number[]): HTMLElement[] {
    const set = new Set(ids);
    const picked: HTMLElement[] = [];
    for (let i = 0; i < out.length; i++) {
      const id = Number(out[i].dataset.id);
      if (set.has(id)) {
        picked.push(out[i]);
        out.splice(i, 1);
        i--;
      }
    }
    return picked;
  }

  for (const rootId of sortedRoots) {
    const rootIdx = out.findIndex((el) => Number(el.dataset.id) === rootId);
    if (rootIdx < 0) continue;

    const memberIds = Array.from(groups.get(rootId)!).sort((a, b) => {
      const ka = linearKey(models.get(a)!, a);
      const kb = linearKey(models.get(b)!, b);
      return ka === kb ? a - b : ka - kb;
    });
    const membersEls = extractMembers(memberIds);
    out.splice(rootIdx + 1, 0, ...membersEls);
  }

  return out;
}

function ensureDepthClassesForWindow(container: HTMLElement, orderMap: Map<number, OrderRecord>): boolean {
  const posts = Array.from(container.querySelectorAll('.PostStream-item[data-id]')) as HTMLElement[];
  if (!posts.length) return false;

  const models = new Map<number, PostModel | null>(
    posts.map((el) => [Number(el.dataset.id), getModel(Number(el.dataset.id))])
  );

  const MAX_DEPTH = 10;

  function applyDepthClasses(itemEl: HTMLElement, depth: number, isEvent: boolean): boolean {
    const postEl = (itemEl.querySelector('.Post') as HTMLElement) || itemEl;
    const toRemove: string[] = [];
    postEl.classList.forEach((c) => {
      if (/^(thread-(root|ed-post|depth-\d+|deep|very-deep))$/.test(c)) toRemove.push(c);
    });
    toRemove.forEach((c) => postEl.classList.remove(c));

    if (isEvent) {
      postEl.classList.add('thread-root');
      return true;
    }

    if (depth > 0) {
      postEl.classList.add('threaded-post', `thread-depth-${Math.min(depth, MAX_DEPTH)}`);
      if (depth >= 3) postEl.classList.add('thread-deep');
      if (depth >= 5) postEl.classList.add('thread-very-deep');
    } else {
      postEl.classList.add('thread-root');
    }
    return true;
  }

  let changed = false;
  for (const item of posts) {
    const id = Number(item.dataset.id);
    const m = models.get(id);
    const event = isEventPostByEl(item, m!);
    const depth = event ? 0 : getThreadDepth(m as any);
    changed = applyDepthClasses(item, depth, event) || changed;
  }
  return changed;
}

async function reorderOnce(container: HTMLElement, did: number): Promise<void> {
  const orderMap = (await waitOrderMap(did)) || new Map();
  const { posts } = findPostsRange(container);
  if (!posts.length) return;

  const { eligible, events, models, parentOf } = computeEligibility(posts, orderMap);
  const base = buildBaseTarget(posts, eligible, events, orderMap, models);
  const target = applyLockedCohesion(base, eligible, events, models, parentOf);

  const domOrderChanged = !sameOrder(posts, target);

  if (domOrderChanged) {
    const latest = findPostsRange(container);
    const anchor = latest.anchor?.parentNode === container ? latest.anchor : null;
    try {
      for (const el of target) {
        if (anchor && anchor.parentNode === container) container.insertBefore(el, anchor);
        else container.appendChild(el);
      }
    } catch (e) {
      console.warn('[Threadify] reorder failed (will retry)', e);
    }
  }

  const classesChanged = ensureDepthClassesForWindow(container, orderMap);

  if (domOrderChanged || classesChanged) {
    scheduleRedraw();
  }
}

export function installDomReorderMode(): void {
  extend(PostStream.prototype, 'oncreate', function (this: PostStreamComponent) {
    const did = getDidFromComponent(this);
    const container = getContainer(this);
    if (!did || !container) return;

    reorderOnce(container, did);

    let isReordering = false;
    let coalesceTimer: ReturnType<typeof setTimeout> | null = null;
    let repairTimer: ReturnType<typeof setInterval> | null = null;

    const observer = new MutationObserver((muts) => {
      const added = muts
        .filter((m) => m.type === 'childList')
        .flatMap((m) => Array.from(m.addedNodes || []))
        .filter((n): n is HTMLElement => n?.nodeType === 1 && (n as Element).matches?.('.PostStream-item[data-id]'));

      if (added.length) {
        if (isReordering) return;
        if (coalesceTimer) clearTimeout(coalesceTimer);
        coalesceTimer = setTimeout(async () => {
          isReordering = true;
          try {
            const map = (await waitOrderMap(did)) || new Map();
            const missing = added.some((el) => !map.has(Number(el.dataset.id)));
            if (missing) {
              invalidateThreadOrder(did);
              await prefetchThreadOrder(did, { force: true });
            }
            await reorderOnce(container, did);
          } catch (e) {
            console.warn('[Threadify] realtime reorder failed', e);
          } finally {
            isReordering = false;
          }
        }, 16);
        return;
      }

      const hydrationHit = muts.some((m) => {
        if (m.type !== 'attributes') return false;
        const el = m.target as Element;
        if (!el?.matches?.('.PostStream-item')) return false;
        if (m.attributeName === 'data-id') return !!el.getAttribute('data-id');
        if (m.attributeName === 'class') {
          const prev = m.oldValue || '';
          const now = el.className || '';
          return /PostStream-item/.test(now) && /Post--saving/.test(prev) && !/Post--saving/.test(now);
        }
        return false;
      });

      if (hydrationHit) {
        if (isReordering) return;
        if (coalesceTimer) clearTimeout(coalesceTimer);
        coalesceTimer = setTimeout(async () => {
          isReordering = true;
          try {
            invalidateThreadOrder(did);
            await prefetchThreadOrder(did, { force: true });
            await reorderOnce(container, did);

            let tries = 0;
            if (repairTimer) clearInterval(repairTimer);
            repairTimer = setInterval(async () => {
              tries++;
              const map = (await waitOrderMap(did)) || new Map();
              const changed = ensureDepthClassesForWindow(container, map);
              if (changed || tries >= 10) {
                if (repairTimer) clearInterval(repairTimer);
                scheduleRedraw();
              }
            }, 150);
          } catch (e) {
            console.warn('[Threadify] hydration reorder failed', e);
          } finally {
            isReordering = false;
          }
        }, 16);
        return;
      }
    });

    observer.observe(container, {
      childList: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ['data-id', 'class'],
      subtree: true,
    });

    this.__threadifyDomObserver = observer;
  });

  extend(PostStream.prototype, 'onremove', function (this: PostStreamComponent) {
    if (this.__threadifyDomObserver) {
      try {
        this.__threadifyDomObserver.disconnect();
      } catch {
        // ignore
      }
      this.__threadifyDomObserver = undefined;
    }
  });

  try {
    window.addEventListener('threadify:order-ready', () => scheduleRedraw());
  } catch {
    // ignore
  }
}
