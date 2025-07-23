/**
 * Post Loader Utilities
 * 
 * Handles loading missing posts that are needed for complete thread rendering.
 * This includes both parent posts (referenced by loaded posts) and child posts
 * (that reference loaded posts as parents).
 * 
 * Uses surgical API calls to minimize data transfer and maintains proper
 * error handling for robust operation.
 * 
 * @author Threadify Extension
 */

/**
 * Load missing parent posts that are referenced but not currently loaded
 * 
 * Scans currently loaded posts for parent_id references and loads any
 * referenced posts that aren't already loaded. This ensures complete
 * thread chains are available for proper threading display.
 * 
 * @param {PostStream} postStream - The PostStream instance
 * @param {Post[]} currentPosts - Currently loaded posts
 * @returns {Promise<Post[]>} - Promise resolving to all posts (current + loaded parents)
 */
export function loadMissingParentPosts(postStream, currentPosts) {
  const currentPostIds = new Set(currentPosts.map(p => p.id()));
  const missingParentIds = [];
  
  // Scan all visible posts for parent_id references
  currentPosts.forEach(post => {
    const parentId = post.attribute('parent_id');
    if (parentId && !currentPostIds.has(String(parentId))) {
      // This post references a parent that isn't currently loaded
      missingParentIds.push(String(parentId));
    }
  });
  
  // Remove duplicates
  const uniqueMissingIds = Array.from(new Set(missingParentIds));
  
  if (uniqueMissingIds.length === 0) {
    // No missing parents, return current posts
    return Promise.resolve(currentPosts);
  }
  
  console.log(`[Threadify] Loading ${uniqueMissingIds.length} missing parent posts`);
  
  // Load missing parent posts via API
  return loadPostsByIds(uniqueMissingIds)
    .then(loadedParents => {
      
      // Combine current posts with loaded parents
      const allPosts = [...currentPosts, ...loadedParents];
      
      // Recursively check if the newly loaded parents also have missing parents
      // This handles deep threading chains where parents also have parents
      return loadMissingParentPosts(postStream, allPosts);
    })
    .catch(error => {
      console.warn('[Threadify] Failed to load parent posts:', error);
      return currentPosts; // Return current posts if loading fails
    });
}

/**
 * Load missing child posts that reference currently visible posts as parents
 * 
 * Loads posts from the discussion that aren't currently visible but reference
 * visible posts as their parents. This ensures child replies are shown even
 * if they weren't initially loaded in the current view.
 * 
 * @param {PostStream} postStream - The PostStream instance  
 * @param {Post[]} currentPosts - Currently loaded posts (including any loaded parents)
 * @returns {Promise<Post[]>} - Promise resolving to all posts (current + loaded children)
 */
export function loadMissingChildren(postStream, currentPosts) {
  const currentPostIds = currentPosts.map(p => p.id());
  
  if (currentPostIds.length === 0) {
    return Promise.resolve(currentPosts);
  }
  
  // Get all post IDs in the discussion
  const discussionPostIds = postStream.discussion.postIds();
  const loadedPostIdSet = new Set(currentPostIds.map(id => String(id)));
  
  // Find unloaded posts that might be children
  const unloadedPostIds = discussionPostIds.filter(id => !loadedPostIdSet.has(String(id)));
  
  if (unloadedPostIds.length === 0) {
    return Promise.resolve(currentPosts);
  }
  
  // Load a sample of recent unloaded posts to check for parent relationships
  // We sample to avoid loading too many posts at once
  const sampleSize = Math.min(30, unloadedPostIds.length);
  const recentUnloaded = unloadedPostIds.slice(-sampleSize); // Get most recent posts
  
  // Load sample posts to check if any are children of visible posts
  return loadPostsByIds(recentUnloaded)
    .then(loadedSamplePosts => {
      // Filter for posts that are actually children of currently visible posts
      const actualChildren = loadedSamplePosts.filter(post => {
        const parentId = post.attribute('parent_id');
        return parentId && currentPostIds.includes(String(parentId));
      });
      
      if (actualChildren.length > 0) {
        // Add the children to our current posts
        const allPostsWithChildren = [...currentPosts, ...actualChildren];
        
        // Recursively check if these children also have children  
        return loadMissingChildren(postStream, allPostsWithChildren);
      } else {
        return currentPosts;
      }
    })
    .catch(error => {
      console.warn('[Threadify] Failed to load child posts:', error);
      return currentPosts;
    });
}

/**
 * Load complete thread context for given posts
 * 
 * Convenience function that loads both missing parents and children
 * for a complete threading context.
 * 
 * @param {PostStream} postStream - The PostStream instance
 * @param {Post[]} posts - Initial posts to build context around
 * @returns {Promise<Post[]>} - Promise resolving to posts with complete thread context
 */
export function loadCompleteThreadContext(postStream, posts) {
  return loadMissingParentPosts(postStream, posts)
    .then(postsWithParents => loadMissingChildren(postStream, postsWithParents))
    .then(allPosts => {
      return allPosts;
    })
    .catch(error => {
      console.warn('[Threadify] Failed to load thread context:', error);
      return posts; // Fallback to original posts
    });
}

/**
 * Load posts by their IDs using Flarum's API
 * 
 * Makes a surgical API call to load specific posts by ID.
 * Handles the Flarum API format and error cases gracefully.
 * 
 * @param {string[]} postIds - Array of post IDs to load
 * @returns {Promise<Post[]>} - Promise resolving to loaded posts
 */
function loadPostsByIds(postIds) {
  if (!postIds || postIds.length === 0) {
    return Promise.resolve([]);
  }
  
  // Create the ID string for the API call
  const idString = postIds.join(',');
  
  // Use Flarum's store to load posts with filter parameter
  return app.store.find('posts', {
    filter: { id: idString }
  });
}

/**
 * Check if posts need thread context loading
 * 
 * Determines if the given posts would benefit from loading additional
 * thread context (missing parents or children).
 * 
 * @param {Post[]} posts - Posts to check
 * @returns {boolean} - True if context loading would be beneficial
 */
export function needsThreadContext(posts) {
  if (!posts || posts.length === 0) {
    return false;
  }
  
  const postIds = new Set(posts.map(p => p.id()));
  
  // Check if any posts reference parents that aren't loaded
  const hasMissingParents = posts.some(post => {
    const parentId = post.attribute('parent_id');
    return parentId && !postIds.has(String(parentId));
  });
  
  return hasMissingParents;
} 