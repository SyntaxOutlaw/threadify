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
      response.included
        .filter(item => item && item.type && item.id) // Filter out null/invalid items
        .forEach(item => {
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
 * Check if threads API is available for a discussion.
 *
 * Modes (configured in admin):
 * - syntaxoutlaw-threadify.mode = "default" (or unset):
 *     Thread all discussions.
 * - syntaxoutlaw-threadify.mode = "tag":
 *     Only thread discussions that have the secondary tag with slug "threadify".
 *
 * We emit console logs so you can see exactly what mode was detected,
 * what tags were found, and why a particular discussion was threaded or not.
 *
 * @param {Discussion} discussion - The discussion to check
 * @returns {boolean} - True if threads API should be used
 */
export function shouldUseThreadsApi(discussion) {
  // Gracefully handle missing discussion (e.g. during early lifecycle)
  if (!discussion) {
    console.log('[Threadify] shouldUseThreadsApi: no discussion, returning false');
    return false;
  }

  // Read the mode and tag settings from forum attributes (exposed via Extend\Settings)
  const rawMode =
    app.forum && typeof app.forum.attribute === 'function'
      ? app.forum.attribute('threadifyMode')
      : null;
  const mode = rawMode || 'default';
  
  const configuredTag =
    app.forum && typeof app.forum.attribute === 'function'
      ? app.forum.attribute('threadifyTag')
      : null;
  const threadifyTag = configuredTag || 'threadify'; // Default to 'threadify' for backward compatibility

  console.log(
    '[Threadify] shouldUseThreadsApi:',
    'discussion id =',
    typeof discussion.id === 'function' ? discussion.id() : discussion.id,
    'mode from setting =',
    rawMode,
    'effective mode =',
    mode,
    'configured tag =',
    threadifyTag
  );

  // Default behavior: thread all discussions
  if (mode === 'default') {
    console.log('[Threadify] shouldUseThreadsApi: mode=default → threading ENABLED for all discussions');
    return true;
  }

  // Tag-based behavior: only thread discussions with the configured tag
  if (mode === 'tag') {
    // If the tags extension is not present, or tags are not loaded, just don't thread.
    let tags = [];

    // Preferred: use the discussion.tags() relationship provided by flarum/tags
    if (typeof discussion.tags === 'function') {
      const rel = discussion.tags();
      if (Array.isArray(rel)) {
        tags = rel;
      }
    } else if (discussion.data && discussion.data.relationships && discussion.data.relationships.tags) {
      // Fallback: raw relationship data, resolve through the store if possible
      const rel = discussion.data.relationships.tags.data || [];
      tags = rel
        .map(tagRel => {
          if (!tagRel || !tagRel.id) return null;
          return app.store && app.store.getById ? app.store.getById('tags', tagRel.id) : null;
        })
        .filter(tag => tag);
    }

    if (!tags || !tags.length) {
      console.log('[Threadify] shouldUseThreadsApi: mode=tag but discussion has no tags → threading DISABLED');
      return false;
    }

    // Compute a debug list of tag slugs
    const tagSlugs = tags.map(t => {
      if (!t) return '(null)';
      if (typeof t.slug === 'function') return t.slug();
      if (t.slug) return t.slug;
      if (t.data && t.data.attributes && t.data.attributes.slug) return t.data.attributes.slug;
      return '(unknown)';
    });

    // Check for the configured tag
    const hasConfiguredTag = tagSlugs.includes(threadifyTag);

    console.log(
      '[Threadify] shouldUseThreadsApi: mode=tag, configured tag =',
      threadifyTag,
      'discussion tags =',
      tagSlugs,
      '→ hasConfiguredTag =',
      hasConfiguredTag
    );

    return hasConfiguredTag;
  }

  // Unknown mode: be conservative and disable threading to avoid surprises
  console.log('[Threadify] shouldUseThreadsApi: unknown mode value', mode, '→ threading DISABLED');
  return false;
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