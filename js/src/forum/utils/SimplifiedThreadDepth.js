/**
 * Simplified Thread Depth Utilities
 * 
 * This replaces the complex ThreadDepth calculation logic with simple
 * utilities that use pre-computed thread depths from the threads API.
 * 
 * Benefits:
 * - No expensive depth calculations on frontend
 * - No caching needed - depth is already computed
 * - More reliable since depth is calculated once on backend
 * - Simpler code with fewer edge cases
 * 
 * @author Threadify Extension
 */

import { getPostThreadMetadata } from './ThreadsApi';

// Maximum allowed thread depth for UI display
const MAX_DISPLAY_DEPTH = 10;

/**
 * Get thread depth for a post
 * 
 * Uses pre-computed depth from threads API metadata instead of calculating.
 * 
 * @param {Post} post - The post to get depth for
 * @returns {number} - The thread depth (0 = root, 1 = reply, etc.)
 */
export function getThreadDepth(post) {
  if (!post) {
    return 0;
  }
  
  // Check if post has threading metadata from threads API
  const metadata = getPostThreadMetadata(post);
  if (metadata) {
    return Math.min(metadata.depth, MAX_DISPLAY_DEPTH);
  }
  
  // Fallback: use old parent_id attribute if available
  const parentId = post.attribute('parent_id');
  if (parentId) {
    // Simple fallback - assume depth 1 for any post with parent
    // This is not as accurate but prevents complete failure
    return 1;
  }
  
  // No threading information available, treat as root
  return 0;
}

/**
 * Get CSS classes for a post based on its thread depth
 * 
 * @param {Post} post - The post to get CSS classes for
 * @returns {string[]} - Array of CSS class names
 */
export function getThreadCssClasses(post) {
  const depth = getThreadDepth(post);
  const classes = [];
  
  if (depth > 0) {
    classes.push('threaded-post');
    classes.push(`thread-depth-${depth}`);
    
    // Add general depth classes for easier styling
    if (depth >= 3) {
      classes.push('thread-deep');
    }
    if (depth >= 5) {
      classes.push('thread-very-deep');
    }
  } else {
    classes.push('thread-root');
  }
  
  // Add metadata-based classes if available
  const metadata = getPostThreadMetadata(post);
  if (metadata) {
    if (metadata.isRoot) {
      classes.push('thread-root-confirmed');
    }
    if (metadata.childCount > 0) {
      classes.push('has-children');
      classes.push(`child-count-${Math.min(metadata.childCount, 10)}`);
    }
    if (metadata.descendantCount > 0) {
      classes.push('has-descendants');
    }
  }
  
  return classes;
}

/**
 * Check if a post is a root post (no parent)
 * 
 * @param {Post} post - The post to check
 * @returns {boolean} - True if post is a root post
 */
export function isRootPost(post) {
  const metadata = getPostThreadMetadata(post);
  if (metadata) {
    return metadata.isRoot;
  }
  
  // Fallback: check if post has no parent_id
  return !post.attribute('parent_id');
}

/**
 * Get thread root ID for a post
 * 
 * @param {Post} post - The post to get root for
 * @returns {string|null} - Root post ID or null if not available
 */
export function getThreadRootId(post) {
  const metadata = getPostThreadMetadata(post);
  if (metadata) {
    return metadata.rootPostId;
  }
  
  // Fallback: if no metadata, assume the post itself is root if no parent
  if (!post.attribute('parent_id')) {
    return post.id();
  }
  
  return null;
}

/**
 * Get child count for a post
 * 
 * @param {Post} post - The post to get child count for
 * @returns {number} - Number of direct children
 */
export function getChildCount(post) {
  const metadata = getPostThreadMetadata(post);
  return metadata ? metadata.childCount : 0;
}

/**
 * Get descendant count for a post
 * 
 * @param {Post} post - The post to get descendant count for
 * @returns {number} - Total number of descendants (children + grandchildren + ...)
 */
export function getDescendantCount(post) {
  const metadata = getPostThreadMetadata(post);
  return metadata ? metadata.descendantCount : 0;
}

/**
 * Get thread path for a post
 * 
 * @param {Post} post - The post to get thread path for
 * @returns {string|null} - Thread path (e.g., "1/5/12") or null if not available
 */
export function getThreadPath(post) {
  const metadata = getPostThreadMetadata(post);
  return metadata ? metadata.threadPath : null;
} 