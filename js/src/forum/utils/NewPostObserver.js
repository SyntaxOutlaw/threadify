import { extend } from 'flarum/common/extend';
import PostStream from 'flarum/forum/components/PostStream';
import { forceRebuildCache } from '../components/ThreadedPostStream'; // 你已有的状态重排入口

/**
 * 安装“新增楼层观察器”：
 * - 监听 PostStream 容器内 childList 变化；
 * - 只要出现 .PostStream-item[data-id] 新节点，就合并抖动后触发一次状态级重排；
 * - 不改 display，不用 flex，不碰 Scrubber。
 */
export function installNewPostObserver() {
  extend(PostStream.prototype, 'oncreate', function () {
    const root = this.element;
    if (!root) return;

    // 避免重复安装
    if (this.__threadifyObs) this.__threadifyObs.disconnect();

    let timer = null;
    const schedule = () => {
      clearTimeout(timer);
      // 合并 30ms 内的新增，避免频繁重排
      timer = setTimeout(() => {
        try {
          forceRebuildCache(this); // 走“状态重排”，不改变 DOM 布局方式
        } catch (e) {
          console.warn('[threadify] forceRebuildCache failed:', e);
        }
      }, 30);
    };

    const obs = new MutationObserver((mutations) => {
      // 仅当新增的节点里包含真正的“楼层”才触发
      const hit = mutations.some((m) =>
        [...m.addedNodes].some(
          (n) => n.nodeType === 1 && n.matches && n.matches('.PostStream-item[data-id]')
        )
      );
      if (hit) schedule();
    });

    obs.observe(root, { childList: true, subtree: true });
    this.__threadifyObs = obs;
    this.__threadifyObsTimer = timer;
  });

  extend(PostStream.prototype, 'onremove', function () {
    if (this.__threadifyObs) this.__threadifyObs.disconnect();
    if (this.__threadifyObsTimer) clearTimeout(this.__threadifyObsTimer);
    this.__threadifyObs = null;
    this.__threadifyObsTimer = null;
  });
}
