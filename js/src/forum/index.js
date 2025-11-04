import app from 'flarum/forum/app';
import { extend } from 'flarum/common/extend';

import DiscussionPage from 'flarum/forum/components/DiscussionPage';
import DiscussionListItem from 'flarum/forum/components/DiscussionListItem';

import { initThreadedPost } from './components/ThreadedPost';
import { initThreadedReplyComposer } from './components/ThreadedReplyComposer';

import { installDomReorderMode } from './utils/DomReorderMode';
import { prefetchThreadOrder } from './utils/ThreadOrderPrefetch'; // 你已有的轻量预取，可继续用来提升首屏命中

// 可选：控制 Threadify 日志的开/关（保持你之前的实现）
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

  const persisted = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
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
  // 1) 提交时自动带上 parent_id（你的已有逻辑）
  initThreadedReplyComposer();

  // 2) 给帖子组件加深度类（可留可去；不会影响 Scrubber）
  initThreadedPost();

  // 3) 安装“DOM 物理重排 + 观察器”模式（核心）
  installDomReorderMode();

  // 4) 提前预取顺序（优化首屏命中）
  extend(DiscussionPage.prototype, 'oninit', function () {
    const did =
      (this.discussion && typeof this.discussion.id === 'function' && this.discussion.id()) ||
      (this.discussion && this.discussion.id) ||
      null;
    if (did) prefetchThreadOrder(did);
  });

  // 5) 在讨论列表悬停/触摸即预取
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

