import app from 'flarum/forum/app';
import { extend } from 'flarum/common/extend';

import DiscussionPage from 'flarum/forum/components/DiscussionPage';
import DiscussionListItem from 'flarum/forum/components/DiscussionListItem';

import { initThreadedPost } from './components/ThreadedPost';
import { initThreadedReplyComposer } from './components/ThreadedReplyComposer';
import { initThreadedPostStream } from './components/ThreadedPostStream';
import { prefetchThreadOrder } from './utils/ThreadOrderPrefetch';

app.initializers.add('syntaxoutlaw-threadify', () => {
  initThreadedPost();
  initThreadedReplyComposer();
  initThreadedPostStream();

  // 进入讨论页即预取
  extend(DiscussionPage.prototype, 'oninit', function () {
    const did = this.discussion && this.discussion.id && this.discussion.id();
    if (did) prefetchThreadOrder(did);
  });

  // 讨论列表项：首次鼠标悬停 / 触摸即预取，提升命中率
  extend(DiscussionListItem.prototype, 'oncreate', function () {
    const discussion = this.attrs.discussion;
    if (!discussion) return;
    const did = discussion.id();
    const handler = () => prefetchThreadOrder(did);
    // 只触发一次即可
    this.element && this.element.addEventListener('mouseenter', handler, { once: true });
    this.element && this.element.addEventListener('touchstart', handler, { once: true, passive: true });
  });
});
