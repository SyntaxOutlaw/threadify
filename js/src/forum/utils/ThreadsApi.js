/**
 * Threads API Utilities
 * 
 * Simple API interface for loading threaded post data from the new
 * threadify_threads table. This replaces the complex dynamic threading
 * logic with efficient pre-computed thread structures.
 * 
 * @author Threadify Extension
 */

/**
 * Load all threads for a discussion
 * 
 * Makes a single API call to get complete thread structure with all
 * posts in proper threaded order. No complex post loading or tree
 * building needed on the frontend.
 * 
 * @param {number} discussionId - The discussion ID to load threads for
 * @returns {Promise<Object[]>} - Promise resolving to array of thread objects
 */
export function loadDiscussionThreads(discussionId) {
  console.log(`[Threadify] Loading threads for discussion ${discussionId}`);
  
  // Use Flarum's request method to call our custom API endpoint
  return app.request({
    method: 'GET',
    url: app.forum.attribute('apiUrl') + '/discussions/' + discussionId + '/threads'
  }).then(response => {
    console.log(`[Threadify] Loaded ${response.data.length} thread entries`);
    
    // Process included data first to populate the store
    if (response.included) {
      console.log(`[Threadify] Processing ${response.included.length} posts`);
      response.included.forEach(item => {
        app.store.pushObject(item);
      });
    }
    
    // Convert thread data to posts with threading metadata
    const postsFromApi = response.data.map(threadData => {
      const postId = threadData.attributes.postId;
      let post = app.store.getById('posts', postId);

      if (post) {
        post._threadDepth = threadData.attributes.depth;
        post._threadPath = threadData.attributes.threadPath;
        post._isRoot = threadData.attributes.isRoot;
        post._childCount = threadData.attributes.childCount;
        post._descendantCount = threadData.attributes.descendantCount;
        post._rootPostId = threadData.attributes.rootPostId;
        post._parentPostId = threadData.attributes.parentPostId;
      }

      return post;
    }).filter(post => post !== null);

    // API returns threads in correct threaded order (backend getDiscussionThreads).
    // Use that order as-is; no frontend reordering.
    console.log(`[Threadify] Processed ${postsFromApi.length} threaded posts (API order)`);
    return postsFromApi;
  }).catch(error => {
    console.error('[Threadify] Failed to load discussion threads:', error);
    
    // Fallback: return empty array - existing PostStream will handle this gracefully
    return [];
  });
}

/**
 * Check if threads API is available for a discussion
 * 
 * @param {Discussion} discussion - The discussion to check
 * @returns {boolean} - True if threads API should be used
 */
export function shouldUseThreadsApi(discussion) {
  // For now, always try to use the threads API
  // In the future, this could be configurable or based on discussion settings
  return true;
}

/**
 * Get thread metadata for a post
 * 
 * Extracts threading information that was added by loadDiscussionThreads
 * 
 * @param {Post} post - The post to get metadata for
 * @returns {Object|null} - Thread metadata or null if not available
 */
export function getPostThreadMetadata(post) {
  if (!post || typeof post._threadDepth === 'undefined') {
    return null;
  }
  
  return {
    depth: post._threadDepth,
    threadPath: post._threadPath,
    isRoot: post._isRoot,
    childCount: post._childCount,
    descendantCount: post._descendantCount,
    rootPostId: post._rootPostId
  };
}

/**
 * Check if a post has threading metadata
 * 
 * @param {Post} post - The post to check
 * @returns {boolean} - True if post has threading metadata
 */
export function hasThreadMetadata(post) {
  return post && typeof post._threadDepth !== 'undefined';
} 