/**
 * Threaded Post Component Extensions
 * 
 * Handles Post component extensions for threading functionality.
 * This module is responsible for:
 * - Adding threading CSS classes to posts based on their depth
 * - Managing post-specific threading visual elements
 * - Integrating with the ThreadDepth utility for depth calculations
 * 
 * @author Threadify Extension
 */

import { extend } from 'flarum/common/extend';
import Post from 'flarum/forum/components/Post';
import { getThreadCssClasses } from '../utils/SimplifiedThreadDepth';

/**
 * Initialize Post component extensions for threading
 * 
 * Sets up all the necessary hooks and extensions for the Post component
 * to display threading information properly.
 */
export function initThreadedPost() {
  // Hook into Post component to add threading CSS classes
  extend(Post.prototype, 'classes', function(classes) {
    const post = this.attrs.post;
    
    // Skip processing if we don't have a valid post
    if (!post) {
      console.warn('[Threadify] No post in ThreadedPost.classes');
      return classes;
    }
    
    // Get threading CSS classes from simplified utility
    const threadClasses = getThreadCssClasses(post);
    console.log(`[Threadify] Adding classes to post ${post.id()}: ${threadClasses.join(', ')}`);
    
    threadClasses.forEach(className => {
      classes.push(className);
    });
    
    return classes;
  });
}

/**
 * Get thread metadata for a post
 * 
 * Extracts useful threading metadata from a post that can be used
 * by other components or for debugging purposes.
 * 
 * @param {Post} post - The post to extract metadata from
 * @param {Post[]} allPosts - All posts in the discussion
 * @returns {Object} - Thread metadata object
 */
export function getPostThreadMetadata(post, allPosts) {
  if (!post) return null;
  
  const parentId = post.attribute('parent_id');
  const parentPost = parentId ? allPosts.find(p => p && p.id() == parentId) : null;
  
  // Find direct children of this post
  const children = allPosts.filter(p => 
    p && p.attribute('parent_id') == post.id()
  );
  
  // Calculate some thread statistics
  const descendants = getDescendantCount(post, allPosts);
  
  return {
    postId: post.id(),
    parentId: parentId,
    hasParent: !!parentPost,
    parentPost: parentPost,
    directChildren: children,
    childrenCount: children.length,
    descendantCount: descendants,
    isRootPost: !parentId,
    threadClasses: getThreadCssClasses(post, allPosts)
  };
}

/**
 * Count all descendants (children, grandchildren, etc.) of a post
 * 
 * @param {Post} post - The post to count descendants for
 * @param {Post[]} allPosts - All posts in the discussion
 * @returns {number} - Total number of descendants
 */
function getDescendantCount(post, allPosts) {
  const directChildren = allPosts.filter(p => 
    p && p.attribute('parent_id') == post.id()
  );
  
  let count = directChildren.length;
  
  // Recursively count descendants of each child
  directChildren.forEach(child => {
    count += getDescendantCount(child, allPosts);
  });
  
  return count;
}

/**
 * Check if a post is part of a specific thread branch
 * 
 * Determines if a post is either a descendant or ancestor of another post.
 * Useful for highlighting related posts or collapsing thread branches.
 * 
 * @param {Post} post1 - First post
 * @param {Post} post2 - Second post  
 * @param {Post[]} allPosts - All posts in the discussion
 * @returns {boolean} - True if posts are in the same thread branch
 */
export function arePostsInSameBranch(post1, post2, allPosts) {
  if (!post1 || !post2 || post1.id() === post2.id()) {
    return false;
  }
  
  // Check if post1 is an ancestor of post2
  let currentPost = post2;
  while (currentPost) {
    const parentId = currentPost.attribute('parent_id');
    if (!parentId) break;
    
    if (parentId == post1.id()) {
      return true; // post1 is an ancestor of post2
    }
    
    currentPost = allPosts.find(p => p && p.id() == parentId);
  }
  
  // Check if post2 is an ancestor of post1
  currentPost = post1;
  while (currentPost) {
    const parentId = currentPost.attribute('parent_id');
    if (!parentId) break;
    
    if (parentId == post2.id()) {
      return true; // post2 is an ancestor of post1
    }
    
    currentPost = allPosts.find(p => p && p.id() == parentId);
  }
  
  return false;
}

/**
 * Get the root post of a thread branch
 * 
 * Traces back through parent relationships to find the root post
 * of the thread branch that contains the given post.
 * 
 * @param {Post} post - The post to find the root for
 * @param {Post[]} allPosts - All posts in the discussion
 * @returns {Post|null} - The root post of the thread branch
 */
export function getThreadRoot(post, allPosts) {
  if (!post) return null;
  
  let currentPost = post;
  let rootPost = post;
  
  // Trace back through parents until we find a post with no parent
  while (currentPost) {
    const parentId = currentPost.attribute('parent_id');
    if (!parentId) {
      rootPost = currentPost;
      break;
    }
    
    const parentPost = allPosts.find(p => p && p.id() == parentId);
    if (!parentPost) {
      // Parent not found, current post becomes the effective root
      rootPost = currentPost;
      break;
    }
    
    rootPost = parentPost;
    currentPost = parentPost;
  }
  
  return rootPost;
} 
