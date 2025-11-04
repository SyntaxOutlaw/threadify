// js/src/forum/index.js
import app from 'flarum/forum/app';
import { extend } from 'flarum/common/extend';

import DiscussionPage from 'flarum/forum/components/DiscussionPage';
import DiscussionListItem from 'flarum/forum/components/DiscussionListItem';

import { initThreadedPost } from './components/ThreadedPost';
import { initThreadedReplyComposer } from './components/ThreadedReplyComposer';
import { initThreadedPostStream } from './components/ThreadedPostStream';
import { prefetchThreadOrder } from './utils/ThreadOrderPrefetch';

/**
 * 日志控制（默认屏蔽，可在控制台开启）
 * 仅影响以 "[Threadify]" 开头的日志；其余 console 输出不受影响。
 */
(function setupThreadifyLoggingToggle() {
  const NS = '[Threadify]';
  const KEY = 'threadify:logs';
  const methods = ['log', 'info', 'warn', 'debug', 'error'];

  // 避免多次包裹
  if (!window.__threadifyConsoleOriginal) {
    window.__threadifyConsoleOriginal = {};
    methods.forEach((name) => {
      window.__threadifyConsoleOriginal[name] =
        console[name] ? console[name].bind(console) : () => {};
    });
  }

  // 默认关闭；读取本地持久化状态
  const persisted =
    typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
  let enabled = persisted === '1';

  // 应用包裹
  function applyWrap() {
    methods.forEach((name) => {
      const original = window.__threadifyConsoleOriginal[name];
      console[name] = (...args) => {
        const first = args && args[0];
        const isThreadifyMsg = typeof first === 'string' && first.indexOf(NS) === 0;
        if (isThreadifyMsg && !enabled) return; // 屏蔽本扩展日志
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

  // 暴露可切换的控制器到全局（控制台使用）
  window.threadifyLogs = {
    enable() {
      setEnabled(true);
      return 'Threadify logs: ON';
    },
    disable() {
      setEnabled(false);
      return 'Threadify logs: OFF';
    },
    toggle() {
      setEnabled(!enabled);
      return `Threadify logs: ${enabled ? 'ON' : 'OFF'}`;
    },
    status() {
      return enabled;
    },
  };

  applyWrap();
})();

app.initializers.add('syntaxoutlaw-threadify', () => {
  // 样式/行为初始化
  initThreadedPost();
  initThreadedReplyComposer();
  initThreadedPostStream();

  // 进入讨论页即预取顺序
  extend(DiscussionPage.prototype, 'oninit', function () {
    const did =
      (this.discussion && typeof this.discussion.id === 'function' && this.discussion.id()) ||
      (this.discussion && this.discussion.id) ||
      null;
    if (did) prefetchThreadOrder(did);
  });

  // 讨论列表项：首个鼠标悬停/触摸即预取，提升命中率
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
