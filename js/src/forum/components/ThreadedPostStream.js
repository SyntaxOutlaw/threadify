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
import { loadMinimalChildren } from '../utils/PostLoader';

// Global state for the PostStream threading system
let isReordering = false; // Prevent infinite loops during reordering
let reorderedPostsCache = null; // Cache for threaded posts arrangement
let lastPostCount = 0; // Track post count to detect actual changes
let originalPostsMethod = null;

// Configuration flag for optional minimal child loading
let enableMinimalChildLoading = false;

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
      // If we have threaded cache, return it
      if (reorderedPostsCache) {
        console.log(`[Threadify] Returning threaded posts (${reorderedPostsCache.filter(p => p).length} posts)`);
        return reorderedPostsCache;
      }
      
      // If no cache, return original posts and trigger rebuild
      const originalPosts = originalPostsMethod.call(this.stream);
      console.log(`[Threadify] No cache, returning original posts (${originalPosts ? originalPosts.filter(p => p).length : 0} posts)`);
      
      // Trigger cache rebuild if we have posts and not currently building
      if (originalPosts && originalPosts.filter(p => p).length > 0 && !isReordering) {
        console.log(`[Threadify] Triggering cache rebuild`);
        updateReorderedCache(this);
      }
      
      return originalPosts;
    };
    
    // Initialize post count for tracking changes using original method
    const currentPosts = originalPostsMethod.call(this.stream);
    lastPostCount = currentPosts ? currentPosts.filter(p => p).length : 0;
    console.log(`[Threadify] Initial post count: ${lastPostCount}`);
    
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
  // Don't interfere if we're already reordering
  if (isReordering) {
    return;
  }
  
  // Check if post count actually changed using original posts method
  if (!originalPostsMethod) return; // No original method stored yet
  
  const currentPosts = originalPostsMethod.call(postStream.stream);
  const currentPostCount = currentPosts ? currentPosts.filter(p => p).length : 0;
  
  // Only rebuild if post count changed (indicating new/removed posts)
  if (currentPostCount !== lastPostCount) {
    console.log(`[Threadify] Post count changed: ${lastPostCount} -> ${currentPostCount}, rebuilding cache`);
    
    // Update tracked count
    lastPostCount = currentPostCount;
    
    // Clear old cache completely and rebuild with simple threading
    reorderedPostsCache = null;
    clearThreadDepthCache();
    
    // Simple immediate rebuild without context loading
    updateReorderedCache(postStream);
  }
}

/**
 * Update the reordered posts cache with simple threaded arrangement
 * 
 * Simplified approach: just do basic threading with current posts,
 * with optional minimal child loading if enabled.
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
    
    // Check if minimal child loading is enabled
    if (enableMinimalChildLoading) {
      // Load minimal children and then apply threading
      loadMinimalChildren(postStream, validPosts)
        .then((postsWithChildren) => {
          if (!isReordering) return; // Skip if another rebuild started
          
          const threadedPosts = createThreadedPosts(postsWithChildren);
          const threadedArray = createThreadedPostsArray(originalPosts, threadedPosts);
          
          reorderedPostsCache = threadedArray;
          console.log(`[Threadify] Applied threading with minimal children (${threadedPosts.length} posts)`);
          
          setTimeout(() => {
            m.redraw();
          }, 10);
        })
        .catch(error => {
          console.warn('[Threadify] Minimal child loading failed, using basic threading:', error);
          // Fallback to basic threading
          const threadedPosts = createThreadedPosts(validPosts);
          const threadedArray = createThreadedPostsArray(originalPosts, threadedPosts);
          reorderedPostsCache = threadedArray;
        })
        .finally(() => {
          isReordering = false;
        });
    } else {
      // Simple threading with current posts only - no context loading
      const threadedPosts = createThreadedPosts(validPosts);
      const threadedArray = createThreadedPostsArray(originalPosts, threadedPosts);
      
      // Update cache
      reorderedPostsCache = threadedArray;
      
      console.log(`[Threadify] Applied simple threading (${threadedPosts.length} posts)`);
      
      // Force immediate redraw
      setTimeout(() => {
        m.redraw();
      }, 10);
      
      isReordering = false;
    }
    
  } catch (error) {
    console.error('[Threadify] Cache update failed:', error);
    isReordering = false;
  }
}

/**
 * Create threaded posts array that preserves all loaded posts in threaded order
 * 
 * Instead of trying to maintain original positions, this creates an array
 * where posts appear in proper threaded order, followed by any null entries
 * for unloaded posts (to maintain pagination).
 * 
 * @param {(Post|null)[]} originalPosts - Original posts array from PostStream
 * @param {Post[]} threadedPosts - Posts in threaded order
 * @returns {(Post|null)[]} - Array with all posts in threaded order
 */
function createThreadedPostsArray(originalPosts, threadedPosts) {
  if (!threadedPosts || threadedPosts.length === 0) {
    return originalPosts;
  }
  
  // Start with all threaded posts in their correct order
  const result = [...threadedPosts];
  
  // Count how many non-null posts were in the original array
  const originalNonNullCount = originalPosts.filter(p => p !== null).length;
  
  // If we have more threaded posts than original non-null posts,
  // it means we loaded additional parent/child posts - that's great!
  // If we have fewer, we need to pad with nulls to maintain pagination
  const nullsNeeded = Math.max(0, originalPosts.length - threadedPosts.length);
  
  // Add null entries at the end to maintain original array length for pagination
  for (let i = 0; i < nullsNeeded; i++) {
    result.push(null);
  }
  
  return result;
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
  console.log('[Threadify] Force rebuilding cache');
  
  // Clear existing cache and depth cache
  reorderedPostsCache = null;
  clearThreadDepthCache();
  
  // Use the simplified rebuild approach
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

/**
 * Get debug information about the current threading state
 * 
 * @returns {Object} - Debug information object
 */
export function getThreadingDebugInfo() {
  return {
    isReordering: isReordering,
    hasCachedPosts: !!reorderedPostsCache,
    cachedPostCount: reorderedPostsCache ? reorderedPostsCache.filter(p => p).length : 0,
    lastPostCount: lastPostCount,
    hasOriginalMethod: !!originalPostsMethod
  };
}

/**
 * Log detailed threading debug information
 */
export function logThreadingDebug() {
  const info = getThreadingDebugInfo();
  console.log('[Threadify] Debug Info:', info);
  
  if (reorderedPostsCache) {
    const posts = reorderedPostsCache.filter(p => p);
    console.log('[Threadify] Cache contains posts:', posts.map(p => `#${p.id()} (parent: ${p.attribute('parent_id') || 'none'})`));
  }
} 

/**
 * Enable or disable minimal child loading
 * 
 * @param {boolean} enabled - Whether to enable minimal child loading
 */
export function setMinimalChildLoading(enabled) {
  enableMinimalChildLoading = enabled;
  console.log(`[Threadify] Minimal child loading ${enabled ? 'enabled' : 'disabled'}`);
} 