// Threadify Extension - Main Entry Point (fixed)
import { initThreadedPostStream } from './components/ThreadedPostStream';
import { initThreadedPost } from './components/ThreadedPost';
import { initThreadedReplyComposer } from './components/ThreadedReplyComposer';

app.initializers.add('syntaxoutlaw-threadify', () => {
  try {
    // 使用稳定版（基于 PostStreamState 的可见页包裹），不要启用简化版 API 流程
    initThreadedPostStream();
    initThreadedPost();
    initThreadedReplyComposer();

    console.log('[Threadify] stable PostStreamState wrapper loaded');

    // 便捷调试
    window.threadifyDebug = {
      forceRebuild: (ps) => {
        const { forceRebuildCache } = require('./components/ThreadedPostStream');
        forceRebuildCache(ps);
      }
    };
  } catch (e) {
    console.error('[Threadify] init failed:', e);
  }
});
