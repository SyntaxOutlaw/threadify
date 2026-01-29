import app from 'flarum/forum/app';

interface OrderRecord {
  order: number;
  depth: number;
  parentId: number | null;
}

interface CacheEntry {
  map: Map<number, OrderRecord>;
  inflight: Promise<void> | null;
  ts: number;
}

const cache = new Map<string, CacheEntry>();
const TTL_MS = 10_000;
const EVT_READY = 'threadify:order-ready';

function coerceDid(discussionId: number | string | null | undefined): string | null {
  if (discussionId == null) return null;
  const n = Number(discussionId);
  return Number.isFinite(n) && n > 0 ? String(n) : null;
}

export function prefetchThreadOrder(
  discussionId: number | string,
  opts: { force?: boolean } = {}
): Promise<void> {
  const did = coerceDid(discussionId);
  if (!did) return Promise.resolve();

  const now = Date.now();
  let entry = cache.get(did);
  if (!entry) {
    entry = { map: new Map(), inflight: null, ts: 0 };
    cache.set(did, entry);
  }

  if (!opts.force && now - entry.ts < TTL_MS) {
    return entry.inflight || Promise.resolve();
  }

  if (entry.inflight && !opts.force) {
    return entry.inflight;
  }

  const bust = now;
  entry.inflight = app
    .request<{ order?: Array<{ postId: number; order: number; depth: number; parentPostId: number | null }> }>({
      method: 'GET',
      url: `${app.forum.attribute('apiUrl')}/discussions/${did}/threads-order?bust=${bust}`,
    })
    .then((res) => {
      const map = new Map<number, OrderRecord>();
      const orders = res?.order || [];
      for (const { postId, order, depth, parentPostId } of orders) {
        map.set(Number(postId), {
          order: Number(order),
          depth: Number.isFinite(depth) ? Number(depth) : 0,
          parentId: parentPostId ? Number(parentPostId) : null,
        });
      }

      entry!.map = map;
      entry!.ts = Date.now();

      try {
        window.dispatchEvent(
          new CustomEvent(EVT_READY, { detail: { discussionId: Number(did) } })
        );
      } catch {
        // ignore
      }
    })
    .catch((e) => {
      console.warn('[Threadify] order prefetch failed', e);
    })
    .finally(() => {
      entry!.inflight = null;
    });

  return entry.inflight;
}

export function getOrderIndex(discussionId: number | string, postId: number | string): number | undefined {
  const map = getCachedOrderMap(discussionId);
  const rec = map?.get(Number(postId));
  return rec?.order;
}

export function getDepthPrefetched(discussionId: number | string, postId: number | string): number | undefined {
  const map = getCachedOrderMap(discussionId);
  const rec = map?.get(Number(postId));
  return rec?.depth;
}

export function getParentPrefetched(discussionId: number | string, postId: number | string): number | null | undefined {
  const map = getCachedOrderMap(discussionId);
  const rec = map?.get(Number(postId));
  return rec?.parentId;
}

export function getCachedOrderMap(discussionId: number | string): Map<number, OrderRecord> | undefined {
  const did = coerceDid(discussionId);
  if (!did) return undefined;
  const entry = cache.get(did);
  return entry?.map;
}

export async function waitOrderMap(discussionId: number | string): Promise<Map<number, OrderRecord>> {
  const did = coerceDid(discussionId);
  if (!did) return new Map();

  const now = Date.now();
  let entry = cache.get(did);
  if (!entry) {
    entry = { map: new Map(), inflight: null, ts: 0 };
    cache.set(did, entry);
  }

  if (now - entry.ts < TTL_MS && entry.map.size >= 0) {
    return entry.map;
  }

  const p = entry.inflight || prefetchThreadOrder(did);
  await p;
  return getCachedOrderMap(did) || new Map();
}

export function hasFreshOrder(discussionId: number | string): boolean {
  const did = coerceDid(discussionId);
  if (!did) return false;
  const entry = cache.get(did);
  if (!entry) return false;
  return Date.now() - (entry.ts || 0) < TTL_MS;
}

export function invalidateThreadOrder(discussionId: number | string): void {
  const did = coerceDid(discussionId);
  if (!did) return;
  const entry = cache.get(did);
  if (entry) entry.ts = 0;
}

export function clearAllThreadOrderCache(): void {
  cache.clear();
}
