import { extend } from 'flarum/common/extend';
import ReplyComposer from 'flarum/forum/components/ReplyComposer';

interface ReplyData {
  content?: string;
  parent_id?: number;
}

interface ThreadingContext {
  primaryParentId: number | null;
  allMentionedPostIds: number[];
  hasMentions: boolean;
  mentionCount: number;
  isThreadedReply: boolean;
}

export function initThreadedReplyComposer(): void {
  extend(ReplyComposer.prototype, 'data', function (data: ReplyData) {
    const parentId = extractParentIdFromContent(data.content);

    if (parentId) {
      data.parent_id = parentId;
    }

    return data;
  });
}

export function extractParentIdFromContent(content: string | undefined): number | null {
  if (!content || typeof content !== 'string') {
    return null;
  }

  const postMentionMatch = content.match(/@"[^"]*"#p(\d+)/);

  if (postMentionMatch?.[1]) {
    const parentId = parseInt(postMentionMatch[1], 10);

    if (!isNaN(parentId) && parentId > 0) {
      return parentId;
    }
  }

  return null;
}

export function extractAllMentionedPostIds(content: string | undefined): number[] {
  if (!content || typeof content !== 'string') {
    return [];
  }

  const postMentionRegex = /@"[^"]*"#p(\d+)/g;
  const matches: number[] = [];
  let match: RegExpExecArray | null;

  while ((match = postMentionRegex.exec(content)) !== null) {
    const postId = parseInt(match[1], 10);
    if (!isNaN(postId) && postId > 0) {
      matches.push(postId);
    }
  }

  return matches;
}

export function hasPostMentions(content: string | undefined): boolean {
  return extractParentIdFromContent(content) !== null;
}

export function getThreadingContext(content: string | undefined): ThreadingContext {
  const primaryParentId = extractParentIdFromContent(content);
  const allMentionedIds = extractAllMentionedPostIds(content);

  return {
    primaryParentId,
    allMentionedPostIds: allMentionedIds,
    hasMentions: allMentionedIds.length > 0,
    mentionCount: allMentionedIds.length,
    isThreadedReply: primaryParentId !== null,
  };
}

export function cleanThreadingData(data: ReplyData): ReplyData {
  const cleanedData = { ...data };

  if (cleanedData.parent_id !== undefined) {
    const parentId = Number(cleanedData.parent_id);
    if (!isNaN(parentId) && parentId > 0) {
      cleanedData.parent_id = parentId;
    } else {
      delete cleanedData.parent_id;
    }
  }

  return cleanedData;
}
