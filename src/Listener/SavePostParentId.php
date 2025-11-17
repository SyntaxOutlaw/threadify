<?php

namespace SyntaxOutlaw\Threadify\Listener;

use Flarum\Post\Event\Saving;

class SavePostParentId
{
    public function handle(Saving $event)
    {
        // [!! OPTIMIZED !!] Removed all error_log calls

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
            $post->parent_id = (int) $parentId;
        }
    }
}
