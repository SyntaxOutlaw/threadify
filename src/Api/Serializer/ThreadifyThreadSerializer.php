<?php

namespace SyntaxOutlaw\Threadify\Api\Serializer;

use Flarum\Api\Serializer\AbstractSerializer;
use Flarum\Api\Serializer\PostSerializer;
use SyntaxOutlaw\Threadify\Model\ThreadifyThread;

class ThreadifyThreadSerializer extends AbstractSerializer
{
    /**
     * The resource type
     */
    protected $type = 'threadify-threads';
    
    /**
     * Get the default set of serialized attributes for a model
     */
    protected function getDefaultAttributes($thread)
    {
        if (!$thread instanceof ThreadifyThread) {
            return [];
        }
        
        return [
            'discussionId' => $thread->discussion_id,
            'postId' => $thread->post_id,
            'parentPostId' => $thread->parent_post_id,
            'rootPostId' => $thread->root_post_id,
            'depth' => $thread->depth,
            'threadPath' => $thread->thread_path,
            'childCount' => $thread->child_count,
            'descendantCount' => $thread->descendant_count,
            'isRoot' => $thread->parent_post_id === null,
            'createdAt' => $this->formatDate($thread->created_at),
            'updatedAt' => $this->formatDate($thread->updated_at),
        ];
    }
    
    /**
     * Include the post data
     */
    protected function post($thread)
    {
        return $this->hasOne($thread, PostSerializer::class, 'post');
    }
} 