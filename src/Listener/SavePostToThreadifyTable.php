<?php

namespace SyntaxOutlaw\Threadify\Listener;

use Flarum\Post\Event\Posted;
use SyntaxOutlaw\Threadify\Model\ThreadifyThread;

class SavePostToThreadifyTable
{
    public function handle(Posted $event)
    {
        $post = $event->post;
        
        error_log("[Threadify] 🎯 SavePostToThreadifyTable called for post {$post->id}");
        error_log("[Threadify] Post type: {$post->type}");
        error_log("[Threadify] Post parent_id: " . ($post->parent_id ?? 'NULL'));
        
        // Only handle comment posts, not other post types
        if ($post->type !== 'comment') {
            error_log("[Threadify] Skipping non-comment post type: {$post->type}");
            return;
        }
        
        error_log("[Threadify] 📝 Creating/updating thread entry for post {$post->id}");
        
        try {
            // Check if thread entry already exists
            $existingThread = ThreadifyThread::where('post_id', $post->id)->first();
            
            if ($existingThread) {
                error_log("[Threadify] Thread entry already exists for post {$post->id}, skipping");
                return;
            }
            
            error_log("[Threadify] No existing thread entry found, creating new one");
            
            // Create new thread entry
            $threadEntry = ThreadifyThread::createForPost($post, $post->parent_id);
            
            error_log("[Threadify] ✅ Created thread entry: post={$post->id}, parent={$post->parent_id}, depth={$threadEntry->depth}, path={$threadEntry->thread_path}");
            
        } catch (\Exception $e) {
            error_log("[Threadify] ❌ Failed to create thread entry for post {$post->id}: " . $e->getMessage());
            error_log("[Threadify] Exception trace: " . $e->getTraceAsString());
        }
    }
} 