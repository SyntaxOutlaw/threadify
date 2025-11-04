import app from 'flarum/forum/app';
import { extend } from 'flarum/common/extend';

import DiscussionPage from 'flarum/forum/components/DiscussionPage';

import { initThreadedPost } from './components/ThreadedPost';
import { initThreadedReplyComposer } from './components/ThreadedReplyComposer';

// 新：基于 API 的 PostStream 重排（保持分页空洞）
import { installApiThreadedPostStream } from './components/ApiThreadedPostStream';
import { prefetchThreadsOrder } from './utils/ThreadsApi';

app.initializers.add('syntaxoutlaw-threadify', () => {
  // 给帖子元素加深度类（与本次改动兼容）
  initThreadedPost();

  // 提交时自动抽取 parent_id
  initThreadedReplyComposer();

  // 安装“API 线程顺序 + posts() 重排”方案
  installApiThreadedPostStream();

  // 打开讨论页先行预取 order（极小 payload，减少首帧重排）
  extend(DiscussionPage.prototype, 'oninit', function () {
    const did = this.discussion && this.discussion.id && this.discussion.id();
    if (did) prefetchThreadsOrder(did);
  });
});
