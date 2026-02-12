/**
 * Threadify Extension - Main Entry Point
 * 
 * This is the main initialization file for the Threadify extension.
 * It imports and initializes all the modular components that provide
 * threading functionality to Flarum discussions.
 * 
 * The extension works by:
 * 1. Intercepting PostStream to reorder posts in threaded structure
 * 2. Adding threading CSS classes to posts for visual indentation
 * 3. Extracting parent_id from post mentions in replies
 * 4. Loading missing thread context (parents/children) as needed
 * 
 * Architecture:
 * - utils/: Core threading utilities (tree building, depth calculation, post loading)
 * - components/: Flarum component extensions (PostStream, Post, ReplyComposer)
 * 
 * @author Threadify Extension
 * @version 1.1
 */

// Import utility modules
import { initThreadedPostStream, getThreadingState, reloadThreads, isThreadingActive } from './components/ThreadedPostStream';
import { initThreadedPost } from './components/ThreadedPost';
import { initThreadedReplyComposer } from './components/ThreadedReplyComposer';

/**
 * Initialize the Threadify extension
 * 
 * This is the main entry point that sets up all threading functionality.
 * Called automatically by Flarum when the extension is loaded.
 */
app.initializers.add('syntaxoutlaw-threadify', () => {
  try {
    // Initialize all threading components with simplified API-based approach
    initThreadedPostStream();  // Threaded post threading via API
    initThreadedPost();                  // Post CSS classes and visual elements  
    initThreadedReplyComposer();         // Parent ID extraction from mentions
    
    console.log('[Threadify] Threaded extension loaded');
    
    // Add global debugging utilities for troubleshooting
    window.threadifyDebug = {
      getState: getThreadingState,
      reload: reloadThreads,
      isActive: isThreadingActive,
      help: () => {
        console.log(`
[Threadify] Debug Commands:
- threadifyDebug.getState() - Get current threading state
- threadifyDebug.reload() - Force reload threads for current discussion
- threadifyDebug.isActive() - Check if threading is currently active
- threadifyDebug.diagnose() - Log why order might be wrong on this page
- threadifyDebug.help() - Show this help
        `);
      },
      diagnose: () => {
        const discussion = app.current.get('discussion');
        const state = getThreadingState();
        const byId = discussion ? app.store.getById('discussions', String(discussion.id())) || app.store.getById('discussions', Number(discussion.id())) : null;
        const postIds = discussion ? (discussion.postIds && discussion.postIds()) : null;
        console.log('[Threadify] Diagnose:', {
          state,
          hasCurrentDiscussion: !!discussion,
          discussionId: discussion ? discussion.id() : null,
          discussionInStore: !!byId,
          sameObject: discussion === byId,
          postIdsLength: postIds ? postIds.length : 0,
          postIdsFirstFive: postIds ? postIds.slice(0, 5) : null,
          relationshipOrder: discussion && discussion.data && discussion.data.relationships && discussion.data.relationships.posts
            ? discussion.data.relationships.posts.data.slice(0, 5).map(x => x.id)
            : null
        });
      }
    };
    
  } catch (error) {
    console.error('[Threadify] Failed to initialize:', error);
  }
});

/**
 * Export utility functions for external access (if needed)
 * 
 * These exports allow other extensions or debugging tools to interact
 * with Threadify's internal functionality.
 */

// Re-export key utility functions for external use
export { createThreadedPosts } from './utils/ThreadTree';
export { calculateThreadDepth, clearThreadDepthCache } from './utils/ThreadDepth';
export { extractParentIdFromContent } from './components/ThreadedReplyComposer';
export { isThreadingActive } from './components/ThreadedPostStream';

/**
 * Get extension version and status information
 * 
 * Useful for debugging and admin panels.
 * 
 * @returns {Object} - Extension status information
 */
export function getThreadifyStatus() {
  return {
    version: '1.1',
    name: 'Threadify',
    author: 'syntaxoutlaw',
    isActive: true,
    components: {
      postStream: 'loaded',
      post: 'loaded', 
      replyComposer: 'loaded'
    },
    features: [
      'Post threading via mentions',
      'Automatic parent/child post loading',
      'Visual thread depth indication',
      'Thread tree caching for performance'
    ]
  };
}
