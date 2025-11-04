// js/src/forum/index.js
import app from 'flarum/forum/app';
import { extend } from 'flarum/common/extend';

import DiscussionPage from 'flarum/forum/components/DiscussionPage';
import DiscussionListItem from 'flarum/forum/components/DiscussionListItem';

import { initThreadedPost } from './components/ThreadedPost';
import { initThreadedReplyComposer } from './components/ThreadedReplyComposer';
// 注：不再覆盖 PostStream.posts；Flex 排序模式走 DOM 层，不改数组顺序
import { installFlexOrderMode } from './utils/FlexOrderMode';
import { prefetchThreadOrder } from './utils/ThreadOrderPrefetch';

/**
 * 日志控制（默认屏蔽，可在控制台开启）
 * 仅影响以 "[Threadify]" 开头的日志；其余 console 输出不受影响。
 */
(function setupThreadifyLoggingToggle() {
  const NS = '[Threadify]';
  const KEY = 'threadify:logs';
  const methods = ['log', 'info', 'warn', 'debug', 'error'];

  if (!window.__threadifyConsoleOriginal) {
    window.__threadifyConsoleOriginal = {};
    methods.forEach((name) => {
      window.__threadifyConsoleOriginal[name] =
        console[name] ? console[name].bind(console) : () => {};
    });
  }

  const persisted =
    typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
  let enabled = persisted === '1';

  function applyWrap() {
    methods.forEach((name) => {
      const original = window.__threadifyConsoleOriginal[name];
      console[name] = (...args) => {
        const first = args && args[0];
        const isThreadifyMsg = typeof first === 'string' && first.indexOf(NS) === 0;
        if (isThreadifyMsg && !enabled) return;
        return original(...args);
      };
    });
  }

  function setEnabled(v) {
    enabled = !!v;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(KEY, enabled ? '1' : '0');
    }
  }

  window.threadifyLogs = {
    enable() { setEnabled(true); return 'Threadify logs: ON'; },
    disable() { setEnabled(false); return 'Threadify logs: OFF'; },
    toggle() { setEnabled(!enabled); return `Threadify logs: ${enabled ? 'ON' : 'OFF'}`; },
    status() { return enabled; },
  };

  applyWrap();
})();

app.initializers.add('syntaxoutlaw-threadify', () => {
  // 仍然保留：给帖子元素补充深度类名等（不与 Flex 排序冲突）
  initThreadedPost();

  // 仍然保留：在提交数据时自动填写 parent_id
  initThreadedReplyComposer();

  // 启用“Flex 可视化排序模式”：不改 posts()，只操作 DOM 的 order 与类名
  installFlexOrderMode();

  // 进入讨论页即预取顺序（payload 极小）
  extend(DiscussionPage.prototype, 'oninit', function () {
    const did =
      (this.discussion && typeof this.discussion.id === 'function' && this.discussion.id()) ||
      (this.discussion && this.discussion.id) ||
      null;
    if (did) prefetchThreadOrder(did);
  });

  // 讨论列表：首个悬停/触摸即预取，提高命中率
  extend(DiscussionListItem.prototype, 'oncreate', function () {
    const discussion = this.attrs.discussion;
    if (!discussion) return;
    const did = discussion.id();
    const handler = () => prefetchThreadOrder(did);

    if (this.element) {
      this.element.addEventListener('mouseenter', handler, { once: true });
      this.element.addEventListener('touchstart', handler, { once: true, passive: true });
    }
  });
});
