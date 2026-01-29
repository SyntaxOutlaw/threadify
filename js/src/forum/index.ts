import app from 'flarum/forum/app';
import { extend } from 'flarum/common/extend';

import DiscussionPage from 'flarum/forum/components/DiscussionPage';
import DiscussionListItem from 'flarum/forum/components/DiscussionListItem';
import Post from 'flarum/forum/components/Post';

import { initThreadedReplyComposer } from './components/ThreadedReplyComposer';
import { installDomReorderMode } from './utils/DomReorderMode';
import { prefetchThreadOrder, getDepthPrefetched } from './utils/ThreadOrderPrefetch';

interface PostAttrs {
  className?: string;
}

interface PostComponent {
  attrs: {
    post?: {
      id(): number;
      discussion(): { id(): number } | null;
    };
  };
}

interface DiscussionPageComponent {
  discussion?: {
    id(): number;
  } | {
    id: number;
  };
}

interface DiscussionListItemComponent {
  attrs: {
    discussion?: {
      id(): number;
    };
  };
  element?: HTMLElement;
}

app.initializers.add('syntaxoutlaw-threadify', () => {
  initThreadedReplyComposer();

  extend(Post.prototype, 'elementAttrs', function (this: PostComponent, attrs: PostAttrs) {
    const post = this.attrs.post;
    if (!post) return;

    const discussion = post.discussion?.();
    const did = discussion?.id?.() ?? null;
    if (!did) return;

    const depth = getDepthPrefetched(did, post.id());

    if (Number.isInteger(depth) && depth! > 0) {
      const safeDepth = Math.min(depth!, 10);
      const classes = ['threaded-post', `thread-depth-${safeDepth}`];
      if (safeDepth >= 3) classes.push('thread-deep');
      if (safeDepth >= 5) classes.push('thread-very-deep');

      attrs.className = (attrs.className || '') + ' ' + classes.join(' ');
    }
  });

  installDomReorderMode();

  extend(DiscussionPage.prototype, 'oninit', function (this: DiscussionPageComponent) {
    const did =
      (this.discussion && typeof (this.discussion as any).id === 'function' && (this.discussion as any).id()) ||
      (this.discussion && (this.discussion as any).id) ||
      null;
    if (did) prefetchThreadOrder(did);
  });

  extend(DiscussionListItem.prototype, 'oncreate', function (this: DiscussionListItemComponent) {
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
