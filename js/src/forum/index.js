// js/src/forum/index.js
import app from 'flarum/forum/app';
import { extend } from 'flarum/common/extend';

import DiscussionPage from 'flarum/forum/components/DiscussionPage';

import { initThreadedPost } from './components/ThreadedPost';
import { initThreadedReplyComposer } from './components/ThreadedReplyComposer';

// 基于 API 的 PostStream 重排（保持分页空洞、兼容 Scrubber）
import { installApiThreadedPostStream } from './components/ApiThreadedPostStream';
import { prefetchThreadsOrder } from './utils/ThreadsApi';

// 可选：监听新增 .PostStream-item[data-id]，在 Realtime/分页新增时合并触发一次状态重排
import { installNewPostObserver } from './utils/NewPostObserver';

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
  // 1) 仅给帖子元素补充深度类（不改 PostStream 布局）
  initThreadedPost();

  // 2) 提交时自动抽取 mentions → parent_id
  initThreadedReplyComposer();

  // 3) 安装“API 线程顺序 + posts() 状态重排”方案（保持分页空洞，Scrubber 可用）
  installApiThreadedPostStream();

  // 4) 监听新增楼层（Realtime/分页加载），合并抖动后触发一次状态重排
  installNewPostObserver();

  // 5) 打开讨论页即预取 order（payload 极小，减少首帧重排）
  extend(DiscussionPage.prototype, 'oninit', function () {
    const did =
      (this.discussion && typeof this.discussion.id === 'function' && this.discussion.id()) ||
      (this.discussion && this.discussion.id) ||
      null;
    if (did) prefetchThreadsOrder(did);
  });

  // 6) 当 /threads-order 预取完成时，若仍在同一讨论页，轻量重绘一次以套用最新顺序
  window.addEventListener('threadify:order-ready', (ev) => {
    const readyDid = ev && ev.detail && ev.detail.discussionId;
    if (!readyDid) return;

    try {
      const page = app.current && app.current.get && app.current.get('component');
      const did =
        (page && page.discussion && typeof page.discussion.id === 'function' && page.discussion.id()) ||
        (page && page.discussion && page.discussion.id) ||
        null;

      if (did && String(did) === String(readyDid)) {
        m.redraw();
      }
    } catch (_) {}
  });
});
