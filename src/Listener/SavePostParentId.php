<?php

namespace SyntaxOutlaw\Threadify\Listener;

use Flarum\Post\Event\Saving;

class SavePostParentId
{
    public function handle(Saving $event)
    {
        // ALWAYS log that this listener is being called
        error_log("[Threadify] 🚀 SavePostParentId listener called!");
        
        $post = $event->post;
        $data = $event->data;
        
        // Debug: Log the entire data structure
        error_log("[Threadify] DEBUG: Full data structure: " . json_encode($data));
        error_log("[Threadify] Post ID being saved: " . ($post->id ?? 'NEW'));
        
        // Check multiple possible locations for parent_id
        $parentId = null;
        
        if (isset($data['attributes']['parent_id'])) {
            $parentId = $data['attributes']['parent_id'];
            error_log("[Threadify] Found parent_id in attributes: {$parentId}");
        } elseif (isset($data['parent_id'])) {
            $parentId = $data['parent_id'];
            error_log("[Threadify] Found parent_id in root: {$parentId}");
        } elseif (isset($data['relationships']['parent']['data']['id'])) {
            $parentId = $data['relationships']['parent']['data']['id'];
            error_log("[Threadify] Found parent_id in relationships: {$parentId}");
        }
        
        if ($parentId && is_numeric($parentId) && $parentId > 0) {
            $post->parent_id = (int) $parentId;
            error_log("[Threadify] ✅ Setting parent_id = {$parentId} for post {$post->id}");
        } else {
            error_log("[Threadify] ❌ No valid parent_id found");
        }
        
        error_log("[Threadify] 🎯 SavePostParentId listener finished");
    }
}
