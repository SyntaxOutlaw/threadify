/**
 * Threaded PostStream Component
 * 
 * Instead of dynamic tree building and complex caching, this simply calls
 * the threads API to get pre-computed thread structures.
 * 
 * Benefits:
 * - Single API call instead of multiple post loading calls  
 * - No complex caching or state management
 * - No dynamic tree building on frontend
 * - Much more reliable and performant
 * - Easier to understand and maintain
 * 
 * @author Threadify Extension
 */

import app from 'flarum/forum/app';
import { extend } from 'flarum/common/extend';
import PostStream from 'flarum/forum/components/PostStream';
import DiscussionPage from 'flarum/forum/components/DiscussionPage';
import { loadDiscussionThreads, shouldUseThreadsApi } from '../utils/ThreadsApi';

let threadsLoaded = false;
let threadedPosts = null;
let currentDiscussionId = null;
let lastPostCount = 0;

function sameDiscussion(a, b) {
  return a != null && b != null && String(a) === String(b);
}

/**
 * Apply threaded order by updating the discussion model's posts relationship.
 * Flarum's postIds() reads from discussion.data.relationships.posts.data,
 * so we set that to our ordered list of { type, id } — no method override.
 */
function applyThreadedOrderToDiscussion(discussionId, postsInOrder) {
  if (!postsInOrder || !postsInOrder.length) return;
  const discussion =
    app.store.getById('discussions', String(discussionId)) ||
    app.store.getById('discussions', Number(discussionId));
  if (!discussion) {
    if (typeof window !== 'undefined' && window.threadifyDebug) {
      console.warn('[Threadify] Discussion not in store:', discussionId, 'store keys:', app.store.data?.discussions ? Object.keys(app.store.data.discussions) : []);
    }
    return;
  }
  const data = postsInOrder.map(p => ({
    type: 'posts',
    id: String(typeof p.id === 'function' ? p.id() : p.id)
  }));
  if (!discussion.data.relationships) discussion.data.relationships = {};
  discussion.data.relationships.posts = { data };
  discussion.freshness = new Date();

  // Force the stream to report "viewing end" so core shows the reply placeholder.
  const stream = app.current.get('stream');
  if (stream && stream.discussion === discussion) {
    stream.viewingEnd = function() {
      return true;
    };
  }
}

function loadThreadsForDiscussion(discussionId) {
  if (!discussionId) return;
  currentDiscussionId = discussionId;
  threadsLoaded = false;
  threadedPosts = null;
  loadDiscussionThreads(discussionId)
    .then(posts => {
      if (!sameDiscussion(currentDiscussionId, discussionId)) return;
      threadedPosts = posts || [];
      threadsLoaded = true;
      lastPostCount = threadedPosts.filter(p => p).length;
      applyThreadedOrderToDiscussion(discussionId, threadedPosts);
      m.redraw();
    })
    .catch(() => {
      threadsLoaded = true;
      threadedPosts = null;
      m.redraw();
    });
}

/**
 * Initialize the Threaded PostStream
 *
 * When the threads API returns, we update the discussion model's posts relationship
 * to the threaded order. Flarum's stream uses discussion.postIds() (which reads
 * that relationship), so no overrides — we just set the right data.
 */
export function initThreadedPostStream() {
  extend(DiscussionPage.prototype, 'show', function(original) {
    return function(discussion) {
      original.call(this, discussion);
      if (!this.stream || !this.stream.discussion) return;
      const discussionModel = this.stream.discussion;
      const discussionId = discussionModel.id();
      if (!sameDiscussion(currentDiscussionId, discussionId)) {
        currentDiscussionId = discussionId;
        threadsLoaded = false;
        threadedPosts = null;
      }
      if (shouldUseThreadsApi(discussionModel)) {
        loadThreadsForDiscussion(discussionId);
      }
    };
  });

  extend(PostStream.prototype, 'oninit', function() {
    const stream = this.stream;
    if (!stream || !stream.discussion) return;
    const discussionId = stream.discussion.id();
    if (!sameDiscussion(currentDiscussionId, discussionId)) {
      currentDiscussionId = discussionId;
      threadsLoaded = false;
      threadedPosts = null;
    }
    if (shouldUseThreadsApi(stream.discussion)) {
      // Force "viewing end" so core shows the reply placeholder (our comment-only order breaks viewingEnd).
      stream.viewingEnd = function() {
        return true;
      };
      if (!threadsLoaded) {
        loadThreadsForDiscussion(discussionId);
      }
    }
  });

  extend(PostStream.prototype, 'onupdate', function() {
    if (!shouldUseThreadsApi(this.stream.discussion)) return;
    const stream = this.stream;
    const count = stream.discussion ? (stream.discussion.postIds() || []).length : 0;
    if (count !== lastPostCount) {
      lastPostCount = count;
      threadsLoaded = false;
      threadedPosts = null;
      loadThreadsForDiscussion(stream.discussion.id());
    }
  });
}

/**
 * Get current threading state (for debugging)
 * 
 * @returns {Object} - Current state information
 */
export function getThreadingState() {
  return {
    threadsLoaded,
    hasThreadedPosts: !!threadedPosts,
    threadedPostCount: threadedPosts ? threadedPosts.length : 0,
    currentDiscussionId
  };
}

/**
 * Force reload threads for current discussion
 * 
 * Useful for testing or when posts are added/modified
 */
export function reloadThreads() {
  threadsLoaded = false;
  threadedPosts = null;
  if (currentDiscussionId) loadThreadsForDiscussion(currentDiscussionId);
  m.redraw();
}

/**
 * Check if threading is currently active
 * 
 * @returns {boolean} - True if threading is active
 */
export function isThreadingActive() {
  return threadsLoaded && !!threadedPosts;
} 