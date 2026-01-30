/**
 * Thread Tree Utilities
 * 
 * Handles building and flattening thread tree structures from Flarum posts.
 * This module is responsible for:
 * - Building hierarchical thread structures from flat post arrays
 * - Flattening thread trees back to linear arrays in threaded order
 * - Maintaining parent-child relationships between posts
 * 
 * @author Threadify Extension
 */

/**
 * Build a threaded tree structure from posts
 * 
 * Takes a flat array of posts and organizes them into a hierarchical tree
 * structure based on their parent_id attributes. Posts without a parent_id
 * become root posts, while posts with parent_id become children of their
 * respective parents.
 * 
 * @param {Post[]} posts - All posts in the discussion
 * @returns {Post[]} - Array of root posts with _threadChildren attached
 */
export function buildThreadTree(posts) {
  const tree = [];
  const postMap = new Map();
  const childrenMap = new Map();
  const id = (p) => (p && typeof p.id === 'function' ? String(p.id()) : String(p));

  // First pass: create post map and initialize children arrays (use string keys for consistency)
  posts.forEach(post => {
    if (!post) return;
    const postId = id(post);
    postMap.set(postId, post);
    childrenMap.set(postId, []);
  });

  // Second pass: organize posts by parent-child relationships
  posts.forEach(post => {
    if (!post) return;
    const parentId = post.attribute('parent_id') ?? post._parentPostId;
    const parentKey = parentId != null ? String(parentId) : null;

    if (parentKey && postMap.has(parentKey)) {
      childrenMap.get(parentKey).push(post);
    } else {
      tree.push(post);
    }
  });

  // Third pass: attach children to posts for easy access
  posts.forEach(post => {
    if (!post) return;
    post._threadChildren = childrenMap.get(id(post)) || [];
  });

  return tree;
}

/**
 * Flatten thread tree back to linear array in threaded order
 * 
 * Takes a hierarchical tree of posts and flattens it back to a linear array
 * while maintaining the threaded order (parent followed by all its children
 * recursively). This preserves the threading visual structure when posts
 * are rendered linearly.
 * 
 * @param {Post[]} rootPosts - Root posts with their children attached via _threadChildren
 * @returns {Post[]} - Flattened array in threaded order
 */
export function flattenThreadTree(rootPosts) {
  const result = [];
  
  /**
   * Recursively add a post and all its children to the result array
   * @param {Post} post - The post to add
   * @param {number} depth - Current nesting depth (for potential future use)
   */
  function addPostAndChildren(post, depth = 0) {
    if (!post) return;
    
    result.push(post);
    
    // Get children and sort them chronologically within each thread level
    const children = post._threadChildren || [];
    children.sort((a, b) => {
      const timeA = a.createdAt ? a.createdAt().getTime() : 0;
      const timeB = b.createdAt ? b.createdAt().getTime() : 0;
      return timeA - timeB;
    });
    
    // Recursively add all children
    children.forEach(child => {
      addPostAndChildren(child, depth + 1);
    });
  }
  
  // Sort root posts chronologically to maintain discussion flow
  rootPosts.sort((a, b) => {
    const timeA = a.createdAt ? a.createdAt().getTime() : 0;
    const timeB = b.createdAt ? b.createdAt().getTime() : 0;
    return timeA - timeB;
  });
  
  // Add each root post and its entire thread branch
  rootPosts.forEach(rootPost => {
    addPostAndChildren(rootPost);
  });
  
  return result;
}

/**
 * Create a threaded post array from flat posts
 * 
 * Convenience function that combines buildThreadTree and flattenThreadTree
 * to convert a flat array of posts directly into threaded order.
 * 
 * @param {Post[]} posts - Flat array of posts
 * @returns {Post[]} - Posts reordered in threaded structure
 */
export function createThreadedPosts(posts) {
  const threadTree = buildThreadTree(posts);
  return flattenThreadTree(threadTree);
} 