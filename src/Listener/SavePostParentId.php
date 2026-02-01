<?php

namespace SyntaxOutlaw\Threadify\Listener;

use Flarum\Post\Event\Saving;
use Flarum\Post\Post;

class SavePostParentId
{
    public function handle(Saving $event): void
    {
        $post = $event->post;
        $data = $event->data;

        $parentId = null;

        if (isset($data['attributes']['parent_id'])) {
            $parentId = $data['attributes']['parent_id'];
        } elseif (isset($data['parent_id'])) {
            $parentId = $data['parent_id'];
        } elseif (isset($data['relationships']['parent']['data']['id'])) {
            $parentId = $data['relationships']['parent']['data']['id'];
        }

        if ($parentId && is_numeric($parentId) && $parentId > 0) {
            $parentId = (int) $parentId;

            // 验证父帖是否存在于同一讨论中
            $parentExists = Post::where('id', $parentId)
                ->where('discussion_id', $post->discussion_id)
                ->exists();

            if ($parentExists) {
                $post->parent_id = $parentId;
            }
        }
    }
}
