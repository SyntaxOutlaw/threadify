// js/src/forum/utils/DomReorderMode.js
// 重排策略：Phase1 评论（同窗 + 子树一致）→ Phase2 事件帖（按时间就位）→ Phase3 locked 黏连 → DOM 应用
// Realtime 兼容：检测新增 → 合并一帧 → 强刷顺序表 → 立即重排
// 作者侧半水合：监听 data-id/class → 强刷 + 重排 +（限时重试）补齐缩进类
// 缩进类即时修补：重排后直接给 .Post 打 thread-depth-* 等类（无需等组件重渲染）
// 锚点复核避免 insertBefore NotFoundError；轻量 redraw 保障 Post.prototype.classes 的后续一致化

import app from 'flarum/forum/app';
import { extend } from 'flarum/common/extend';
import PostStream from 'flarum/forum/components/PostStream';
import { waitOrderMap, prefetchThreadOrder, invalidateThreadOrder } from '../utils/ThreadOrderPrefetch';

const BIG = 10_000_000;

/* ---------- mithril redraw throttle ---------- */
let redrawScheduled = false;
function scheduleRedraw() {
  if (redrawScheduled) return;
  redrawScheduled = true;
  try {
    requestAnimationFrame(() => {
      redrawScheduled = false;
      if (typeof m === 'function' && typeof m.redraw === 'function') m.redraw();
    });
  } catch { redrawScheduled = false; }
}

/* ---------- DOM helpers ---------- */
function getDidFromComponent(ps){ try{ return ps?.stream?.discussion?.id?.() ?? null; }catch{ return null; } }
function getContainer(ps){
  if (ps?.element?.classList?.contains('PostStream')) return ps.element;
  return ps?.element?.querySelector?.('.PostStream') || document.querySelector('.PostStream') || null;
}
function isPostItem(el){ return el && el.nodeType===1 && el.matches('.PostStream-item[data-id]'); }
function findPostsRange(container){
  const kids = Array.from(container?.children || []);
  if (!kids.length) return { posts: [], anchor: null };
  let L = kids.findIndex(isPostItem); if (L<0) return { posts: [], anchor: kids[0] || null };
  let R = kids.length-1 - [...kids].reverse().findIndex(isPostItem); if (R<L) R = L;
  const posts = kids.slice(L, R+1).filter(isPostItem);
  const anchor = kids[R+1] || null;
  return { posts, anchor };
}
function sameOrder(a,b){ if (a.length!==b.length) return false; for(let i=0;i<a.length;i++) if(a[i]!==b[i]) return false; return true; }

/* ---------- model helpers ---------- */
function getModel(id){ try{ return app.store.getById('posts', String(id)); }catch{ return null; } }
function getNumber(m){ try{ const n=m?.number?.(); return Number.isFinite(n)?n:null; }catch{ return null; } }
function getCreatedTs(m){ try{ const d=m?.createdAt?.(); return d instanceof Date ? +d : null; }catch{ return null; } }
function getContentType(m){
  try{
    if (!m) return null;
    if (typeof m.contentType==='function') return m.contentType();
    if (typeof m.attribute==='function') return m.attribute('contentType') ?? null;
  }catch{}
  return null;
}
function isEventPostByEl(el, m){
  const ct = getContentType(m);
  if (ct && ct !== 'comment') return true;
  if (el?.classList?.contains('EventPost') || el?.classList?.contains('Post-event')) return true;
  if (el?.querySelector?.('.EventPost, .Post-event, .EventPost-icon')) return true;
  return false;
}

/* ---------- order keys ---------- */
function orderKey(rec, m, id){
  if (rec && Number.isFinite(rec.order)) return Number(rec.order);
  const n=getNumber(m); if(n!=null) return n;
  const t=getCreatedTs(m); if(t!=null) return BIG/2 + t;
  return BIG + Number(id);
}
function linearKey(m, id){
  const t=getCreatedTs(m); if(t!=null) return t;
  const n=getNumber(m);   if(n!=null) return BIG/2 + n;
  return BIG + Number(id);
}

/* ---------- eligibility ---------- */
function computeEligibility(posts, orderMap){
  const present = new Set(posts.map(el => Number(el.dataset.id)));
  const models  = new Map(posts.map(el => [Number(el.dataset.id), getModel(Number(el.dataset.id))]));

  const parentOf = new Map();
  for (const el of posts){
    const id = Number(el.dataset.id);
    const rec = orderMap.get(id);
    const m   = models.get(id);
    const pid = rec ? rec.parentId : (m?.attribute ? m.attribute('parent_id') : null);
    parentOf.set(id, pid == null ? null : Number(pid));
  }

  const events = new Set();
  for (const el of posts){
    const id = Number(el.dataset.id);
    if (isEventPostByEl(el, models.get(id))) events.add(id);
  }

  const eligible = new Set();
  for (const el of posts){
    const id = Number(el.dataset.id);
    if (events.has(id)) continue;
    if (parentOf.get(id) == null) eligible.add(id);
  }

  let changed = true;
  while (changed){
    changed = false;
    for (const el of posts){
      const id = Number(el.dataset.id);
      if (eligible.has(id) || events.has(id)) continue;
      const pid = parentOf.get(id);
      if (pid == null) continue;
      if (!present.has(pid)) continue;
      if (!eligible.has(pid)) continue;
      eligible.add(id); changed = true;
    }
  }

  return { eligible, events, models, parentOf, present };
}

/* ---------- build phases ---------- */
function buildBaseTarget(posts, eligible, events, orderMap, models){
  const eligList = posts.filter(el => eligible.has(Number(el.dataset.id)));
  const sortedElig = eligList.slice().sort((a,b)=>{
    const ida=Number(a.dataset.id), idb=Number(b.dataset.id);
    const ka=orderKey(orderMap.get(ida), models.get(ida), ida);
    const kb=orderKey(orderMap.get(idb), models.get(idb), idb);
    return ka===kb ? ida-idb : ka-kb;
  });

  const base=[]; let j=0;
  for (const el of posts){
    const id=Number(el.dataset.id);
    base.push(eligible.has(id) ? sortedElig[j++] : el);
  }

  const withoutEvents = base.filter(el => !events.has(Number(el.dataset.id)));
  const evtList = posts.filter(el => events.has(Number(el.dataset.id))).sort((a,b)=>{
    const ida=Number(a.dataset.id), idb=Number(b.dataset.id);
    const ka=linearKey(models.get(ida), ida), kb=linearKey(models.get(idb), idb);
    return ka===kb ? ida-idb : ka-kb;
  });

  const out = withoutEvents.slice();
  const commentKey = (el)=> linearKey(models.get(Number(el.dataset.id)), Number(el.dataset.id));

  for (const evEl of evtList){
    const eid=Number(evEl.dataset.id);
    const ek =linearKey(models.get(eid), eid);
    let insertAt=-1;
    for (let i=0;i<out.length;i++){ if (commentKey(out[i]) > ek) { insertAt=i; break; } }
    if (insertAt===-1) out.push(evEl); else out.splice(insertAt,0,evEl);
  }
  return out;
}

function applyLockedCohesion(sequence, eligible, events, models, parentOf){
  const presentIds = sequence.map(el => Number(el.dataset.id));
  const present    = new Set(presentIds);
  const locked     = new Set(presentIds.filter(id => !events.has(id) && !eligible.has(id)));
  if (!locked.size) return sequence;

  function nearestVisibleLockedAncestor(id){
    let cur=id;
    for (let g=0; g<100; g++){
      const pid = parentOf.get(cur);
      if (pid == null) return null;
      if (!present.has(pid)) return null;
      if (locked.has(pid)) return pid;
      cur = pid;
    }
    return null;
  }

  const groups = new Map();
  for (const id of locked){
    const root = nearestVisibleLockedAncestor(id);
    if (root == null || root === id) continue;
    if (!groups.has(root)) groups.set(root, new Set());
    groups.get(root).add(id);
  }
  if (!groups.size) return sequence;

  const out = sequence.slice();
  const indexOfId = new Map(out.map((el,idx)=>[Number(el.dataset.id), idx]));
  const sortedRoots = Array.from(groups.keys()).sort((a,b)=> indexOfId.get(a)-indexOfId.get(b));

  function extractMembers(ids){
    const set = new Set(ids); const picked=[];
    for (let i=0;i<out.length;i++){
      const id=Number(out[i].dataset.id);
      if (set.has(id)){ picked.push(out[i]); out.splice(i,1); i--; }
    }
    return picked;
  }

  for (const rootId of sortedRoots){
    const rootIdx = out.findIndex(el => Number(el.dataset.id)===rootId);
    if (rootIdx < 0) continue;
    const memberIds = Array.from(groups.get(rootId)).sort((a,b)=>{
      const ka=linearKey(models.get(a),a), kb=linearKey(models.get(b),b);
      return ka===kb ? a-b : ka-kb;
    });
    const membersEls = extractMembers(memberIds);
    out.splice(rootIdx+1, 0, ...membersEls);
  }
  return out;
}

/* ---------- depth class patch ---------- */
function ensureDepthClassesForWindow(container, orderMap){
  const posts = Array.from(container.querySelectorAll('.PostStream-item[data-id]'));
  if (!posts.length) return false;

  const models  = new Map(posts.map(el => [Number(el.dataset.id), getModel(Number(el.dataset.id))]));
  const parentOf= new Map(posts.map(el=>{
    const id=Number(el.dataset.id);
    const rec=orderMap.get(id);
    const m =models.get(id);
    const pid= rec ? rec.parentId : (m?.attribute ? m.attribute('parent_id') : null);
    return [id, pid==null ? null : Number(pid)];
  }));

  const MAX_DEPTH=10;
  const clamp=(n)=>Number.isFinite(n)?Math.max(0,Math.min(MAX_DEPTH,n)):0;

  function computeDepth(id){
    const rec=orderMap.get(id);
    if (rec && Number.isInteger(rec.depth)) return clamp(rec.depth);
    let depth=0, guard=0, cur=id; const seen=new Set([id]);
    while (guard++<100){
      const pid=parentOf.get(cur);
      if (!pid) break;
      if (seen.has(pid)) { depth=0; break; }
      seen.add(pid); depth++; cur=pid;
      if (depth>=MAX_DEPTH) break;
    }
    return clamp(depth);
  }

  function applyDepthClasses(itemEl, depth, isEvent){
    const postEl = itemEl.querySelector('.Post') || itemEl;
    const toRemove=[];
    postEl.classList.forEach(c => { if (/^(thread-(root|ed-post|depth-\d+|deep|very-deep))$/.test(c)) toRemove.push(c); });
    toRemove.forEach(c => postEl.classList.remove(c));
    if (isEvent){ postEl.classList.add('thread-root'); return true; }
    if (depth>0){
      postEl.classList.add('threaded-post', `thread-depth-${depth}`);
      if (depth>=3) postEl.classList.add('thread-deep');
      if (depth>=5) postEl.classList.add('thread-very-deep');
    } else {
      postEl.classList.add('thread-root');
    }
    return true;
  }

  let changed=false;
  for (const item of posts){
    const id=Number(item.dataset.id);
    const m =models.get(id);
    const event = isEventPostByEl(item, m);
    const depth = event ? 0 : computeDepth(id);
    changed = applyDepthClasses(item, depth, event) || changed;
  }
  return changed;
}

/* ---------- one-shot pipeline ---------- */
async function reorderOnce(container, did){
  const orderMap = (await waitOrderMap(did)) || new Map();
  const { posts } = findPostsRange(container);
  if (!posts.length) return;

  const { eligible, events, models, parentOf } = computeEligibility(posts, orderMap);
  const base   = buildBaseTarget(posts, eligible, events, orderMap, models);
  const target = applyLockedCohesion(base, eligible, events, models, parentOf);

  if (!sameOrder(posts, target)){
    const latest = findPostsRange(container);
    const anchor = (latest.anchor && latest.anchor.parentNode===container) ? latest.anchor : null;
    try {
      for (const el of target){
        if (anchor && anchor.parentNode===container) container.insertBefore(el, anchor);
        else container.appendChild(el);
      }
    } catch(e){ console.warn('[Threadify] reorder failed (will retry)', e); }
  }

  ensureDepthClassesForWindow(container, orderMap);
  scheduleRedraw();
}

/* ---------- lifecycle with realtime + hydration + removal deferral + scroll idle gate ---------- */
export function installDomReorderMode(){
  extend(PostStream.prototype, 'oncreate', function (){
    const did = getDidFromComponent(this);
    const container = getContainer(this);
    if (!did || !container) return;

    // per-instance state
    const state = {
      isReordering: false,
      coalesceTimer: null,
      repairTimer: null,
      removalTimer: null,
      pauseUntil: 0,
      scrollBusy: false,
      scrollIdleTimer: null,
    };
    this.__threadify = state;

    // scroll idle detector (window级，Flarum通常用window滚动)
    const onScroll = () => {
      state.scrollBusy = true;
      clearTimeout(state.scrollIdleTimer);
      state.scrollIdleTimer = setTimeout(() => { state.scrollBusy = false; }, 120);
    };
    try { window.addEventListener('scroll', onScroll, { passive: true }); } catch {}

    const safeReorder = async () => {
      if (state.isReordering) return;
      const now = Date.now();
      if (now < state.pauseUntil) return;
      if (state.scrollBusy) return; // 等滚动空闲
      state.isReordering = true;
      try { await reorderOnce(container, did); }
      finally { state.isReordering = false; }
    };

    // 初始重排
    reorderOnce(container, did);

    const observer = new MutationObserver((muts) => {
      const childListMuts = muts.filter(m => m.type === 'childList');

      /* 新增（Realtime/分页） */
      const added = childListMuts
        .flatMap(m => Array.from(m.addedNodes || []))
        .filter(n => n && n.nodeType===1 && n.matches && n.matches('.PostStream-item[data-id]'));
      if (added.length){
        clearTimeout(state.coalesceTimer);
        state.coalesceTimer = setTimeout(async () => {
          if (state.isReordering) return;
          state.isReordering = true;
          try {
            const map = (await waitOrderMap(did)) || new Map();
            const missing = added.some(el => !map.has(Number(el.dataset.id)));
            if (missing){ invalidateThreadOrder(did); await prefetchThreadOrder(did, { force: true }); }
            await reorderOnce(container, did);
          } catch(e){ console.warn('[Threadify] realtime reorder failed', e); }
          finally { state.isReordering = false; }
        }, 16);
        return;
      }

      /* 作者侧半水合 */
      const hydrationHit = muts.some((m) => {
        if (m.type !== 'attributes') return false;
        const el = m.target;
        if (!el?.matches?.('.PostStream-item')) return false;
        if (m.attributeName === 'data-id') return !!el.getAttribute('data-id');
        if (m.attributeName === 'class'){
          const prev = m.oldValue || ''; const now = el.className || '';
          return /PostStream-item/.test(now) && /Post--saving/.test(prev) && !/Post--saving/.test(now);
        }
        return false;
      });
      if (hydrationHit){
        clearTimeout(state.coalesceTimer);
        state.coalesceTimer = setTimeout(async () => {
          if (state.isReordering) return;
          state.isReordering = true;
          try {
            invalidateThreadOrder(did);
            await prefetchThreadOrder(did, { force: true });
            await reorderOnce(container, did);
            // 限时重试（缩进类修补）
            let tries = 0;
            clearInterval(state.repairTimer);
            state.repairTimer = setInterval(async () => {
              tries++;
              const map = (await waitOrderMap(did)) || new Map();
              const changed = ensureDepthClassesForWindow(container, map);
              if (changed || tries >= 10){ clearInterval(state.repairTimer); scheduleRedraw(); }
            }, 150);
          } catch(e){ console.warn('[Threadify] hydration reorder failed', e); }
          finally { state.isReordering = false; }
        }, 16);
        return;
      }

      /* 仅移除（删除/隐藏）：延后 + 等滚动空闲 + 双 rAF */
      const removed = childListMuts
        .flatMap(m => Array.from(m.removedNodes || []))
        .filter(n => n && n.nodeType===1 && n.matches && n.matches('.PostStream-item, .EventPost, .Post'));
      if (removed.length){
        const loadingHint = container.querySelector('.LoadingIndicator, .PostStream-loading, .Post--loading');
        const baseDelay = loadingHint ? 160 : 96;
        state.pauseUntil = Date.now() + baseDelay + 100; // onupdate 期间暂停重排

        clearTimeout(state.removalTimer);
        const kick = () => {
          // 等滚动空闲
          if (state.scrollBusy || Date.now() < state.pauseUntil){
            state.removalTimer = setTimeout(kick, 48);
            return;
          }
          requestAnimationFrame(() => {
            requestAnimationFrame(async () => { await safeReorder(); });
          });
        };
        state.removalTimer = setTimeout(kick, baseDelay);
        return;
      }

      /* 其它变化：轻量归一化（滚动忙时跳过） */
      requestAnimationFrame(() => safeReorder());
    });

    observer.observe(container, {
      childList: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ['data-id', 'class'],
      subtree: true,
    });

    this.__threadifyDomObserver = observer;

    // 清理
    this.__threadifyCleanup = () => {
      try { observer.disconnect(); } catch {}
      try { window.removeEventListener('scroll', onScroll, { passive: true }); } catch {}
      clearTimeout(state.coalesceTimer);
      clearTimeout(state.removalTimer);
      clearInterval(state.repairTimer);
    };
  });

  extend(PostStream.prototype, 'onupdate', function (){
    const did = getDidFromComponent(this);
    const container = getContainer(this);
    if (!did || !container) return;
    const state = this.__threadify;
    // 删帖/分页后的冷却或滚动忙时，跳过本次重排
    if (state && (Date.now() < state.pauseUntil || state.scrollBusy || state.isReordering)) return;
    reorderOnce(container, did);
  });

  extend(PostStream.prototype, 'onremove', function (){
    if (this.__threadifyCleanup) { try{ this.__threadifyCleanup(); }catch{} this.__threadifyCleanup=null; }
    if (this.__threadify) this.__threadify=null;
  });

  try { window.addEventListener('threadify:order-ready', () => scheduleRedraw()); } catch {}
}
