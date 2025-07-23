/**
 * Thread Depth Calculator
 * 
 * Handles calculating and caching thread depth for posts.
 * Thread depth determines how many levels deep a post is in a thread
 * (0 = root post, 1 = direct reply, 2 = reply to reply, etc.)
 * 
 * Uses caching to avoid expensive recalculations and includes cycle detection
 * to prevent infinite loops in case of malformed parent relationships.
 * 
 * @author Threadify Extension
 */

// Cache for thread depth calculations to avoid recalculating
const threadDepthCache = new Map();

// Maximum allowed thread depth to prevent excessive UI indentation
const MAX_THREAD_DEPTH = 10;

/**
 * Calculate the thread depth of a post
 * 
 * Determines how many levels deep a post is in the thread hierarchy.
 * Uses caching for performance and includes cycle detection for safety.
 * 
 * @param {Post} post - The post to calculate depth for
 * @param {Post[]} allPosts - All posts in the discussion (for parent lookup)
 * @returns {number} - The depth (0 = root, 1 = direct reply, etc.)
 */
export function calculateThreadDepth(post, allPosts) {
  const postId = post.id();
  
  // Check cache first for performance
  if (threadDepthCache.has(postId)) {
    return threadDepthCache.get(postId);
  }
  
  // If no parent_id, this is a root post (depth 0)
  const parentId = post.attribute('parent_id');
  if (!parentId) {
    threadDepthCache.set(postId, 0);
    return 0;
  }
  
  // Find the parent post
  const parentPost = allPosts.find(p => p && p.id() == parentId);
  if (!parentPost) {
    // Parent not found, treat as root
    threadDepthCache.set(postId, 0);
    return 0;
  }
  
  // Cycle detection: if we're calculating depth for a post that's already
  // in our calculation chain, we have a cycle
  const visited = new Set();
  const depth = calculateDepthRecursive(post, allPosts, visited);
  
  // Cache and return the calculated depth
  threadDepthCache.set(postId, depth);
  return depth;
}

/**
 * Recursive helper for depth calculation with cycle detection
 * @param {Post} post - Current post
 * @param {Post[]} allPosts - All posts for parent lookup
 * @param {Set} visited - Set of visited post IDs to detect cycles
 * @returns {number} - Calculated depth
 */
function calculateDepthRecursive(post, allPosts, visited) {
  const postId = post.id();
  
  // Cycle detection
  if (visited.has(postId)) {
    console.warn(`[Threadify] Cycle detected for post ${postId}`);
    return 0; // Treat cyclic posts as root to break the cycle
  }
  
  // Check cache
  if (threadDepthCache.has(postId)) {
    return threadDepthCache.get(postId);
  }
  
  // If no parent, this is root level
  const parentId = post.attribute('parent_id');
  if (!parentId) {
    return 0;
  }
  
  // Find parent post
  const parentPost = allPosts.find(p => p && p.id() == parentId);
  if (!parentPost) {
    return 0; // Parent not found, treat as root
  }
  
  // Add current post to visited set
  visited.add(postId);
  
  // Recursively calculate parent's depth
  const parentDepth = calculateDepthRecursive(parentPost, allPosts, visited);
  const depth = parentDepth + 1;
  
  // Remove from visited set (backtrack)
  visited.delete(postId);
  
  // Apply maximum depth limit to prevent excessive UI indentation
  return Math.min(depth, MAX_THREAD_DEPTH);
}

/**
 * Clear the thread depth cache
 * 
 * Should be called when posts are updated, removed, or when switching discussions
 * to ensure fresh calculations.
 */
export function clearThreadDepthCache() {
  threadDepthCache.clear();
}

/**
 * Get CSS classes for a post based on its thread depth
 * 
 * Generates appropriate CSS classes for styling threaded posts.
 * 
 * @param {Post} post - The post to generate classes for
 * @param {Post[]} allPosts - All posts in the discussion
 * @returns {string[]} - Array of CSS classes
 */
export function getThreadCssClasses(post, allPosts) {
  const threadDepth = calculateThreadDepth(post, allPosts);
  const classes = [];
  
  if (threadDepth > 0) {
    classes.push('Post--threaded');
    classes.push(`Post--thread-depth-${threadDepth}`);
  }
  
  return classes;
}

/**
 * Check if a post is a root post (no parent)
 * @param {Post} post - The post to check
 * @returns {boolean} - True if the post is a root post
 */
export function isRootPost(post) {
  return !post.attribute('parent_id');
}

/**
 * Check if a post is a direct reply (depth 1)
 * @param {Post} post - The post to check
 * @param {Post[]} allPosts - All posts in the discussion
 * @returns {boolean} - True if the post is a direct reply
 */
export function isDirectReply(post, allPosts) {
  return calculateThreadDepth(post, allPosts) === 1;
} 