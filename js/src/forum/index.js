import app from 'flarum/forum/app';
import DiscussionPage from 'flarum/forum/components/DiscussionPage';
import { extend } from 'flarum/common/extend';

import { initThreadedPost } from './components/ThreadedPost';
import { initThreadedReplyComposer } from './components/ThreadedReplyComposer';
import { initThreadedPostStream } from './components/ThreadedPostStream'; // 用你当前的（无首帧阻断）版本
import { prefetchThreadOrder } from './utils/ThreadOrderPrefetch';

app.initializers.add('syntaxoutlaw-threadify', () => {
  initThreadedPost();
  initThreadedReplyComposer();
  initThreadedPostStream();

  // 讨论页 oninit 立刻预取顺序（payload 极小，通常 < 10ms）
  extend(DiscussionPage.prototype, 'oninit', function() {
    const did = this.discussion && this.discussion.id && this.discussion.id();
    if (did) prefetchThreadOrder(did);
  });
});
