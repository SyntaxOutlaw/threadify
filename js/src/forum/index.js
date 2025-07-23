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
 * @version 1.0.0
 */

// Import utility modules
import { initThreadedPostStream } from './components/ThreadedPostStream';
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
    // Initialize all threading components
    initThreadedPostStream();  // Core post reordering and caching
    initThreadedPost();        // Post CSS classes and visual elements  
    initThreadedReplyComposer(); // Parent ID extraction from mentions
    
    console.log('[Threadify] Extension loaded');
    
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
export { getThreadedPostsCache, isThreadingActive } from './components/ThreadedPostStream';

/**
 * Get extension version and status information
 * 
 * Useful for debugging and admin panels.
 * 
 * @returns {Object} - Extension status information
 */
export function getThreadifyStatus() {
  return {
    version: '1.0.0',
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
