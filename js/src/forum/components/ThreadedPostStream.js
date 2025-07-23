/**
 * Threaded PostStream Component Extensions
 * 
 * Handles PostStream component extensions for threading functionality.
 * This is the core module that manages:
 * - Overriding PostStream's posts() method to return threaded posts
 * - Caching threaded post arrangements for performance
 * - Detecting when posts change and rebuilding thread cache
 * - Integrating with PostLoader for complete thread context
 * - Managing the complex lifecycle of post stream updates
 * 
 * @author Threadify Extension
 */

import { extend } from 'flarum/common/extend';
import PostStream from 'flarum/forum/components/PostStream';
import { createThreadedPosts } from '../utils/ThreadTree';
import { clearThreadDepthCache } from '../utils/ThreadDepth';
import { loadCompleteThreadContext } from '../utils/PostLoader';

// Global state for the PostStream threading system
let isReordering = false; // Prevent infinite loops during reordering
let reorderedPostsCache = null; // Cache for threaded posts arrangement
let lastPostCount = 0; // Track post count to detect actual changes
let originalPostsMethod = null; // Store reference to original posts method

/**
 * Initialize PostStream component extensions for threading
 * 
 * Sets up all the necessary hooks and overrides to make PostStream
 * display posts in threaded order while maintaining compatibility
 * with Flarum's existing post loading and updating mechanisms.
 */
export function initThreadedPostStream() {
  // Override posts method immediately when PostStream initializes (before any rendering)
  extend(PostStream.prototype, 'oninit', function() {
    
    // Store reference to original posts method
    originalPostsMethod = this.stream.posts;
    
    // Override posts() method immediately, before any rendering
    this.stream.posts = () => {
      // If we have threaded cache and we're not in the middle of reordering, return threaded posts
      if (reorderedPostsCache && !isReordering) {
        return reorderedPostsCache;
      }
      
      // Otherwise return original posts (allows Flarum to add new posts normally)
      return originalPostsMethod.call(this.stream);
    };
    
    // Initialize post count for tracking changes using original method
    const currentPosts = originalPostsMethod.call(this.stream);
    lastPostCount = currentPosts ? currentPosts.filter(p => p).length : 0;
    
    // Immediately build threaded cache if we have posts
    if (currentPosts && currentPosts.length > 0) {
      updateReorderedCache(this);
    }
  });
  
  // Hook into PostStream.view() to ensure cache is ready during rendering
  extend(PostStream.prototype, 'view', function(result) {
    // Update our reordered cache if needed
    if (!reorderedPostsCache && originalPostsMethod) {
      updateReorderedCache(this);
    }
    
    return result;
  });
  
  // Clear caches when component is created (discussion change, etc.)
  extend(PostStream.prototype, 'oncreate', function() {
    clearThreadDepthCache();
    // Note: Don't clear reorderedPostsCache here as it was built in oninit
  });
  
  // Rebuild cache immediately when posts are updated
  extend(PostStream.prototype, 'onupdate', function() {
    handlePostStreamUpdate(this);
  });
}

/**
 * Handle PostStream updates and rebuild cache when needed
 * 
 * @param {PostStream} postStream - The PostStream instance
 */
function handlePostStreamUpdate(postStream) {
  // Check if post count actually changed using original posts method
  if (!originalPostsMethod) return; // No original method stored yet
  
  const currentPosts = originalPostsMethod.call(postStream.stream);
  const currentPostCount = currentPosts ? currentPosts.filter(p => p).length : 0;
  
  // Only rebuild if post count changed (indicating new/removed posts)
  if (currentPostCount !== lastPostCount) {
    // Update tracked count
    lastPostCount = currentPostCount;
    
    // Clear old caches
    reorderedPostsCache = null;
    clearThreadDepthCache();
    
    // Immediately rebuild cache with new posts
    updateReorderedCache(postStream);
    
    // Force a redraw to show the threaded layout
    setTimeout(() => {
      m.redraw();
    }, 50);
  }
  // If post count unchanged, do nothing (let normal updates proceed silently)
}

/**
 * Update the reordered posts cache with threaded arrangement
 * 
 * This is the core function that builds the threaded post cache.
 * It loads missing thread context and arranges posts in threaded order.
 * 
 * @param {PostStream} postStream - The PostStream instance
 */
function updateReorderedCache(postStream) {
  if (isReordering) {
    return;
  }
  
  isReordering = true;
  
  try {
    // Get the ORIGINAL posts from the stream using the stored original method
    if (!originalPostsMethod) {
      reorderedPostsCache = null;
      return;
    }
    
    const originalPosts = originalPostsMethod.call(postStream.stream);
    
    if (!originalPosts || originalPosts.length === 0) {
      reorderedPostsCache = null;
      return;
    }
    
    // Filter out null/undefined posts
    const validPosts = originalPosts.filter(post => post);
    
    if (validPosts.length === 0) {
      reorderedPostsCache = null;
      return;
    }
    
    // Load complete thread context (missing parents and children)
    loadCompleteThreadContext(postStream, validPosts)
      .then((allPosts) => {
        // Use all posts (including loaded parents AND children) for threading
        const postsForThreading = allPosts || validPosts;
        
        // Create threaded arrangement
        const reorderedPosts = createThreadedPosts(postsForThreading);
        
        // Create the final posts array maintaining original structure
        const newPostsArray = createReorderedPostsArray(originalPosts, reorderedPosts);
        
        // Cache the reordered posts
        reorderedPostsCache = newPostsArray;
        
        // Single redraw with everything loaded
        if (allPosts && allPosts.length > validPosts.length) {
          setTimeout(() => {
            m.redraw();
          }, 0);
        }
      })
      .catch(error => {
        console.warn('[Threadify] Threading failed, using basic mode:', error);
        
        // Fallback: just do basic threading with current posts
        const reorderedPosts = createThreadedPosts(validPosts);
        const newPostsArray = createReorderedPostsArray(originalPosts, reorderedPosts);
        
        reorderedPostsCache = newPostsArray;
      });
      
  } finally {
    isReordering = false;
  }
}

/**
 * Create reordered posts array while maintaining original structure
 * 
 * Takes the original posts array (with null entries for unloaded posts)
 * and the reordered posts, then creates a new array that maintains
 * the original structure but with posts in threaded order.
 * 
 * @param {(Post|null)[]} originalPosts - Original posts array from PostStream
 * @param {Post[]} reorderedPosts - Posts in threaded order
 * @returns {(Post|null)[]} - New array with threaded order but original structure
 */
function createReorderedPostsArray(originalPosts, reorderedPosts) {
  const newPostsArray = [];
  let reorderedIndex = 0;
  
  originalPosts.forEach((originalPost, index) => {
    if (originalPost) {
      // Use the reordered post
      newPostsArray[index] = reorderedPosts[reorderedIndex] || originalPost;
      reorderedIndex++;
    } else {
      // Keep null entries as-is for unloaded posts
      newPostsArray[index] = null;
    }
  });
  
  return newPostsArray;
}

/**
 * Get the current threaded posts cache
 * 
 * @returns {(Post|null)[]|null} - The cached threaded posts or null if not available
 */
export function getThreadedPostsCache() {
  return reorderedPostsCache;
}

/**
 * Force rebuild of the threaded posts cache
 * 
 * Useful for external components that need to trigger a cache rebuild,
 * such as after manual post operations.
 * 
 * @param {PostStream} postStream - The PostStream instance
 */
export function forceRebuildCache(postStream) {
  // Clear existing cache
  reorderedPostsCache = null;
  clearThreadDepthCache();
  
  // Rebuild cache
  updateReorderedCache(postStream);
}

/**
 * Check if threading is currently active
 * 
 * @returns {boolean} - True if threading is active and cache is available
 */
export function isThreadingActive() {
  return !!(reorderedPostsCache && originalPostsMethod);
}

/**
 * Get threading statistics for debugging
 * 
 * @returns {Object} - Object containing threading statistics
 */
export function getThreadingStats() {
  return {
    hasCachedPosts: !!reorderedPostsCache,
    cachedPostCount: reorderedPostsCache ? reorderedPostsCache.filter(p => p).length : 0,
    isReordering: isReordering,
    lastPostCount: lastPostCount,
    hasOriginalMethod: !!originalPostsMethod
  };
} 