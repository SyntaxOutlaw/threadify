/**
 * Simplified Threaded PostStream Component
 *
 * Uses pre-computed threads from API instead of complex frontend logic.
 * This version mutes console logs by default.
 * @author Threadify
 */

import { extend } from 'flarum/common/extend';
import PostStream from 'flarum/forum/components/PostStream';
import { loadDiscussionThreads, shouldUseThreadsApi } from '../utils/ThreadsApi';

// ---- Debug helper (mute by default) ----
const DBG = false; // 改为 true 可临时开启日志
const d = (...a) => { if (DBG) console.info('[Threadify]', ...a); };

// Simple state management
let threadsLoaded = false;
let threadedPosts = null;
let currentDiscussionId = null;
let lastPostCount = 0; // Track last post count to detect updates

/**
 * Initialize the simplified threaded PostStream
 */
export function initSimplifiedThreadedPostStream() {
  // Override posts method when PostStream initializes
  extend(PostStream.prototype, 'oninit', function () {
    d('Initializing simplified threaded PostStream');

    // Get discussion ID
    const discussionId = this.stream.discussion.id();

    // Reset state if discussion changed
    if (currentDiscussionId !== discussionId) {
      d('Discussion changed, resetting thread state');
      threadsLoaded = false;
      threadedPosts = null;
      currentDiscussionId = discussionId;
    }

    // Load threads if needed
    if (shouldUseThreadsApi(this.stream.discussion) && !threadsLoaded) {
      d('Loading threaded posts from API');
      loadThreadedPosts(this);
    }
  });

  // Handle discussion changes
  extend(PostStream.prototype, 'oncreate', function () {
    const discussionId = this.stream.discussion.id();

    if (currentDiscussionId !== discussionId) {
      d('Discussion changed in oncreate, resetting');
      threadsLoaded = false;
      threadedPosts = null;
      currentDiscussionId = discussionId;

      if (shouldUseThreadsApi(this.stream.discussion)) {
        loadThreadedPosts(this);
      }
    }
  });

  // Reload when post count changes
  extend(PostStream.prototype, 'onupdate', function () {
    if (!shouldUseThreadsApi(this.stream.discussion)) return;

    const currentPosts = this.stream.posts();
    const currentPostCount = currentPosts ? currentPosts.filter((p) => p).length : 0;

    if (currentPostCount !== lastPostCount) {
      d(`Post count changed: ${lastPostCount} -> ${currentPostCount}, reloading threads`);
      lastPostCount = currentPostCount;

      threadsLoaded = false;
      threadedPosts = null;
      loadThreadedPosts(this);
    }
  });

  // Clean up when component is destroyed
  extend(PostStream.prototype, 'onremove', function () {
    d('PostStream being removed, cleaning up');
  });

  // Override the posts getter to return threaded posts when available
  extend(PostStream.prototype, 'posts', function (original) {
    if (threadsLoaded && threadedPosts && currentDiscussionId === this.stream.discussion.id()) {
      d(`Returning cached threaded posts (${threadedPosts.length} posts)`);
      return threadedPosts;
    }

    const originalPosts = original();
    d(`Returning original posts (${originalPosts ? originalPosts.length : 0} posts)`);
    return originalPosts;
  });
}

/**
 * Load threaded posts from the API
 * @param {PostStream} postStream
 */
function loadThreadedPosts(postStream) {
  const discussionId = postStream.stream.discussion.id();
  d(`Loading threads for discussion ${discussionId}`);

  loadDiscussionThreads(discussionId)
    .then((posts) => {
      if (currentDiscussionId === discussionId) {
        threadedPosts = posts;
        threadsLoaded = true;

        lastPostCount = posts ? posts.filter((p) => p).length : 0;

        d(`Successfully loaded ${threadedPosts.length} threaded posts`);
        if (DBG) {
          // 仅在调试时输出样例
          // eslint-disable-next-line no-console
          console.info('[Threadify] Sample post metadata:',
            threadedPosts[0]
              ? {
                  id: threadedPosts[0].id(),
                  depth: threadedPosts[0]._threadDepth,
                  hasUser: !!threadedPosts[0].user,
                  userFunction: typeof threadedPosts[0].user,
                }
              : 'No posts'
          );
        }

        m.redraw();
      } else {
        d('Discussion changed while loading, ignoring results');
      }
    })
    .catch((error) => {
      // 真正的错误仍保留
      // eslint-disable-next-line no-console
      console.error('[Threadify] Failed to load threaded posts:', error);

      threadsLoaded = true; // prevent infinite retries
      threadedPosts = null; // fallback to original posts
    });
}

/** Debug helpers (used by window.threadifyDebug in index if needed) */
export function getThreadingState() {
  return {
    threadsLoaded,
    hasThreadedPosts: !!threadedPosts,
    threadedPostCount: threadedPosts ? threadedPosts.length : 0,
    currentDiscussionId,
  };
}

export function reloadThreads() {
  d('Force reloading threads');
  threadsLoaded = false;
  threadedPosts = null;
  m.redraw();
}

export function isThreadingActive() {
  return threadsLoaded && !!threadedPosts;
}
