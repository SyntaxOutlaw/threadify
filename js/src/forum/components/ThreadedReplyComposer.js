/**
 * Threaded Reply Composer Extensions
 * 
 * Handles ReplyComposer component extensions for threading functionality.
 * This module is responsible for:
 * - Extracting parent_id from post mentions in reply content
 * - Adding parent_id to the reply data before submission
 * - Integrating with Flarum's mentions extension for seamless threading
 * 
 * The threading system works by detecting post mentions in the format:
 * @"Display Name"#p123 where 123 is the post ID that becomes the parent_id
 * 
 * @author Threadify Extension
 */

import { extend } from 'flarum/common/extend';
import ReplyComposer from 'flarum/forum/components/ReplyComposer';

/**
 * Initialize ReplyComposer component extensions for threading
 * 
 * Sets up hooks to automatically detect and add parent_id relationships
 * when users reply to specific posts using the mentions system.
 * 
 * Note: We always extract and save parent_id from mentions, regardless of
 * whether Threadify is currently active for the discussion. This ensures
 * that threading relationships are preserved if Threadify is enabled later,
 * or if the discussion mode changes from "tag" to "default".
 */
export function initThreadedReplyComposer() {
  // Hook into reply submission to add parent_id
  extend(ReplyComposer.prototype, 'data', function(data) {
    // Always extract parent_id from mentions - it's useful metadata regardless of threading mode
    const parentId = extractParentIdFromContent(data.content);
    
    if (parentId) {
      // Add parent_id directly to the data object
      data.parent_id = parentId;
      console.log('[Threadify] Reply threading to post', parentId);
    }
    
    return data;
  });
}

/**
 * Extract parent post ID from reply content
 * 
 * Parses the reply content for post mentions from the mentions extension
 * and extracts the post ID to use as parent_id for threading.
 * 
 * Supported mention formats:
 * - @"Display Name"#p123 (standard post mention)
 * - Multiple mentions (uses the first one found)
 * 
 * @param {string} content - The reply content to parse
 * @returns {number|null} - The parent post ID or null if none found
 */
export function extractParentIdFromContent(content) {
  if (!content || typeof content !== 'string') {
    return null;
  }
  
  // Parse the content for post mentions from the mentions extension
  // Format: @"Display Name"#p123 where 123 is the post ID
  const postMentionMatch = content.match(/@"[^"]*"#p(\d+)/);
  
  if (postMentionMatch && postMentionMatch[1]) {
    const parentId = parseInt(postMentionMatch[1], 10);
    
    // Validate that it's a valid number
    if (!isNaN(parentId) && parentId > 0) {
      return parentId;
    }
  }
  
  return null;
}

/**
 * Extract all mentioned post IDs from content
 * 
 * Gets all post mentions from the content, not just the first one.
 * Useful for analytics or advanced threading features.
 * 
 * @param {string} content - The reply content to parse
 * @returns {number[]} - Array of mentioned post IDs
 */
export function extractAllMentionedPostIds(content) {
  if (!content || typeof content !== 'string') {
    return [];
  }
  
  const postMentionRegex = /@"[^"]*"#p(\d+)/g;
  const matches = [];
  let match;
  
  while ((match = postMentionRegex.exec(content)) !== null) {
    const postId = parseInt(match[1], 10);
    if (!isNaN(postId) && postId > 0) {
      matches.push(postId);
    }
  }
  
  return matches;
}

/**
 * Check if content contains post mentions
 * 
 * @param {string} content - The content to check
 * @returns {boolean} - True if content contains post mentions
 */
export function hasPostMentions(content) {
  return extractParentIdFromContent(content) !== null;
}

/**
 * Get threading context from reply content
 * 
 * Extracts comprehensive threading information from reply content,
 * including the primary parent and any additional mentioned posts.
 * 
 * @param {string} content - The reply content to analyze
 * @returns {Object} - Threading context object
 */
export function getThreadingContext(content) {
  const primaryParentId = extractParentIdFromContent(content);
  const allMentionedIds = extractAllMentionedPostIds(content);
  
  return {
    primaryParentId: primaryParentId,
    allMentionedPostIds: allMentionedIds,
    hasMentions: allMentionedIds.length > 0,
    mentionCount: allMentionedIds.length,
    isThreadedReply: primaryParentId !== null
  };
}

/**
 * Validate threading data before submission
 * 
 * Performs validation on the threading data to ensure it's valid
 * before the reply is submitted to the server.
 * 
 * @param {Object} data - The reply data object
 * @returns {Object} - Validation result with isValid boolean and any error messages
 */
export function validateThreadingData(data) {
  const result = {
    isValid: true,
    errors: [],
    warnings: []
  };
  
  // Check if parent_id is present and valid
  if (data.parent_id !== undefined) {
    if (typeof data.parent_id !== 'number' || data.parent_id <= 0) {
      result.isValid = false;
      result.errors.push('Invalid parent_id: must be a positive number');
    }
  }
  
  // Check for potential threading issues
  if (data.content && hasPostMentions(data.content)) {
    const context = getThreadingContext(data.content);
    
    if (!data.parent_id && context.isThreadedReply) {
      result.warnings.push('Content contains post mentions but no parent_id was set');
    }
    
    if (context.mentionCount > 1) {
      result.warnings.push(`Multiple post mentions found (${context.mentionCount}), only first will be used for threading`);
    }
  }
  
  return result;
}

/**
 * Clean threading data for submission
 * 
 * Ensures threading data is properly formatted and cleaned before
 * being sent to the server.
 * 
 * @param {Object} data - The reply data object
 * @returns {Object} - Cleaned data object
 */
export function cleanThreadingData(data) {
  const cleanedData = { ...data };
  
  // Ensure parent_id is a proper integer or remove it
  if (cleanedData.parent_id !== undefined) {
    const parentId = parseInt(cleanedData.parent_id, 10);
    if (!isNaN(parentId) && parentId > 0) {
      cleanedData.parent_id = parentId;
    } else {
      delete cleanedData.parent_id;
    }
  }
  
  return cleanedData;
} 