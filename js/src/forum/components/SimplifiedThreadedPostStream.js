/**
 * Simplified Threaded PostStream Component
 * 
 * This is a complete replacement for the complex ThreadedPostStream logic.
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

import { extend } from 'flarum/common/extend';
import PostStream from 'flarum/forum/components/PostStream';
import { loadDiscussionThreads, shouldUseThreadsApi } from '../utils/ThreadsApi';

// Simple state management - no complex caching needed
let threadsLoaded = false;
let threadedPosts = null;
let currentDiscussionId = null;
let lastPostCount = 0; // Track last post count to detect updates

/**
 * Initialize the simplified threaded PostStream
 * 
 * This replaces the complex threading logic with a simple API-based approach.
 */
export function initSimplifiedThreadedPostStream() {
  
  // Override posts method when PostStream initializes
  extend(PostStream.prototype, 'oninit', function() {
    console.log('[Threadify] Initializing simplified threaded PostStream');
    
    // Get discussion ID
    const discussionId = this.stream.discussion.id();
    
    // Reset state if discussion changed
    if (currentDiscussionId !== discussionId) {
      console.log('[Threadify] Discussion changed, resetting thread state');
      threadsLoaded = false;
      threadedPosts = null;
      currentDiscussionId = discussionId;
    }
    
    // Load threads if needed
    if (shouldUseThreadsApi(this.stream.discussion) && !threadsLoaded) {
      console.log('[Threadify] Loading threaded posts from API');
      loadThreadedPosts(this);
    }
  });
  
  // Handle discussion changes
  extend(PostStream.prototype, 'oncreate', function() {
    const discussionId = this.stream.discussion.id();
    
    // Reset if discussion changed
    if (currentDiscussionId !== discussionId) {
      console.log('[Threadify] Discussion changed in oncreate, resetting');
      threadsLoaded = false;
      threadedPosts = null;
      currentDiscussionId = discussionId;
      
      // Load threads for new discussion
      if (shouldUseThreadsApi(this.stream.discussion)) {
        loadThreadedPosts(this);
      }
    }
  });

  // Handle post stream updates to reload threads when new posts are added
  extend(PostStream.prototype, 'onupdate', function() {
    // Only check for updates if we're using threads API
    if (!shouldUseThreadsApi(this.stream.discussion)) {
      return;
    }
    
    // Get current post count from the stream
    const currentPosts = this.stream.posts();
    const currentPostCount = currentPosts ? currentPosts.filter(p => p).length : 0;
    
    // If post count changed, reload threads
    if (currentPostCount !== lastPostCount) {
      console.log(`[Threadify] Post count changed: ${lastPostCount} -> ${currentPostCount}, reloading threads`);
      lastPostCount = currentPostCount;
      
      // Reset and reload
      threadsLoaded = false;
      threadedPosts = null;
      loadThreadedPosts(this);
    }
  });

  // Clean up when component is destroyed
  extend(PostStream.prototype, 'onremove', function() {
    console.log('[Threadify] PostStream being removed, cleaning up');
    // Don't reset state here as it might be needed for other instances
  });

  // Override the posts getter to return threaded posts when available
  extend(PostStream.prototype, 'posts', function(original) {
    // If we have threaded posts loaded for this discussion, return them
    if (threadsLoaded && threadedPosts && currentDiscussionId === this.stream.discussion.id()) {
      console.log(`[Threadify] Returning cached threaded posts (${threadedPosts.length} posts)`);
      return threadedPosts;
    }
    
    // Otherwise return original posts
    const originalPosts = original();
    console.log(`[Threadify] Returning original posts (${originalPosts ? originalPosts.length : 0} posts)`);
    return originalPosts;
  });
}

/**
 * Load threaded posts from the API
 * 
 * @param {PostStream} postStream - The PostStream instance
 */
function loadThreadedPosts(postStream) {
  const discussionId = postStream.stream.discussion.id();
  
  console.log(`[Threadify] Loading threads for discussion ${discussionId}`);
  
  loadDiscussionThreads(discussionId)
    .then(posts => {
      // Only update if we're still on the same discussion
      if (currentDiscussionId === discussionId) {
        threadedPosts = posts;
        threadsLoaded = true;
        
        // Update post count tracking
        lastPostCount = posts ? posts.filter(p => p).length : 0;
        
        console.log(`[Threadify] Successfully loaded ${threadedPosts.length} threaded posts`);
        console.log('[Threadify] Sample post metadata:', threadedPosts[0] ? {
          id: threadedPosts[0].id(),
          depth: threadedPosts[0]._threadDepth,
          hasUser: !!threadedPosts[0].user,
          userFunction: typeof threadedPosts[0].user
        } : 'No posts');
        
        m.redraw();
      } else {
        console.log('[Threadify] Discussion changed while loading, ignoring results');
      }
    })
    .catch(error => {
      console.error('[Threadify] Failed to load threaded posts:', error);
      
      // Mark as loaded anyway to prevent infinite retries
      threadsLoaded = true;
      
      // Keep using original posts as fallback
      threadedPosts = null;
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
  console.log('[Threadify] Force reloading threads');
  threadsLoaded = false;
  threadedPosts = null;
  
  // Trigger a redraw to start the reload process
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