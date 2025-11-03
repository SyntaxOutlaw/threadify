/**
 * Threaded Post Component Extensions
 * Adds CSS classes based on depth. This version mutes logs by default.
 */

import { extend } from 'flarum/common/extend';
import Post from 'flarum/forum/components/Post';
import { getThreadCssClasses } from '../utils/SimplifiedThreadDepth';

// ---- Debug helper (mute by default) ----
const DBG = false; // 改为 true 可临时开启日志
const d = (...a) => { if (DBG) console.info('[Threadify]', ...a); };

export function initThreadedPost() {
  extend(Post.prototype, 'classes', function (classes) {
    const post = this.attrs.post;
    if (!post) {
      d('No post in ThreadedPost.classes');
      return classes;
    }

    const threadClasses = getThreadCssClasses(post);
    d(`Adding classes to post ${post.id()}: ${threadClasses.join(', ')}`);

    threadClasses.forEach((className) => {
      classes.push(className);
    });

    return classes;
    });
}

/** Utilities (unchanged) */
export function getPostThreadMetadata(post, allPosts) {
  if (!post) return null;

  const parentId = post.attribute('parent_id');
  const parentPost = parentId ? allPosts.find((p) => p && p.id() == parentId) : null;

  const children = allPosts.filter((p) => p && p.attribute('parent_id') == post.id());
  const descendants = getDescendantCount(post, allPosts);

  return {
    postId: post.id(),
    parentId,
    hasParent: !!parentPost,
    parentPost,
    directChildren: children,
    childrenCount: children.length,
    descendantCount: descendants,
    isRootPost: !parentId,
    threadClasses: getThreadCssClasses(post, allPosts),
  };
}

function getDescendantCount(post, allPosts) {
  const directChildren = allPosts.filter((p) => p && p.attribute('parent_id') == post.id());
  let count = directChildren.length;
  directChildren.forEach((child) => {
    count += getDescendantCount(child, allPosts);
  });
  return count;
}

export function arePostsInSameBranch(post1, post2, allPosts) {
  if (!post1 || !post2 || post1.id() === post2.id()) return false;

  // post1 ancestor of post2?
  let currentPost = post2;
  while (currentPost) {
    const parentId = currentPost.attribute('parent_id');
    if (!parentId) break;
    if (parentId == post1.id()) return true;
    currentPost = allPosts.find((p) => p && p.id() == parentId);
  }

  // post2 ancestor of post1?
  currentPost = post1;
  while (currentPost) {
    const parentId = currentPost.attribute('parent_id');
    if (!parentId) break;
    if (parentId == post2.id()) return true;
    currentPost = allPosts.find((p) => p && p.id() == parentId);
  }

  return false;
}

export function getThreadRoot(post, allPosts) {
  if (!post) return null;

  let currentPost = post;
  let rootPost = post;

  while (currentPost) {
    const parentId = currentPost.attribute('parent_id');
    if (!parentId) {
      rootPost = currentPost;
      break;
    }
    const parentPost = allPosts.find((p) => p && p.id() == parentId);
    if (!parentPost) {
      rootPost = currentPost;
      break;
    }
    rootPost = parentPost;
    currentPost = parentPost;
  }

  return rootPost;
}
