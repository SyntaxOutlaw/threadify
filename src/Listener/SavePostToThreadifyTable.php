<?php

namespace SyntaxOutlaw\Threadify\Listener;

use Flarum\Post\Event\Posted;
use SyntaxOutlaw\Threadify\Model\ThreadifyThread;

class SavePostToThreadifyTable
{
    public function handle(Posted $event)
    {
        $post = $event->post;
        
        // [!! OPTIMIZED !!] Removed all error_log calls
        
        // Only handle comment posts, not other post types
        if ($post->type !== 'comment') {
            return;
        }
        
        try {
            // Check if thread entry already exists
            $existingThread = ThreadifyThread::where('post_id', $post->id)->first();
            
            if ($existingThread) {
                return;
            }
            
            // Create new thread entry
            ThreadifyThread::createForPost($post, $post->parent_id);
            
        } catch (\Exception $e) {
            // [!! OPTIMIZED !!] Removed log, but kept error handling
            // In a real production app, you would log this to a proper Flarum log
            resolve('log')->error('[Threadify] ❌ Failed to create thread entry for post ' . $post->id . ': ' . $e->getMessage());
        }
    }
}
