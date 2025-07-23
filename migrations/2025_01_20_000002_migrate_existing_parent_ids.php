<?php

use Illuminate\Database\Schema\Blueprint;
use Illuminate\Database\Schema\Builder;

return [
    'up' => function (Builder $schema) {
        $connection = $schema->getConnection();
        
        // Get all posts that don't have parent_id set
        $posts = $connection->table('posts')
            ->whereNull('parent_id')
            ->where('type', 'comment')
            ->get();
        
        $updated = 0;
        $skipped = 0;
        
        foreach ($posts as $post) {
            $parentId = extractParentFromContent($post->content);
            
            if ($parentId) {
                // Verify the parent post exists and is in the same discussion
                $parentExists = $connection->table('posts')
                    ->where('id', $parentId)
                    ->where('discussion_id', $post->discussion_id)
                    ->exists();
                
                if ($parentExists) {
                    $connection->table('posts')
                        ->where('id', $post->id)
                        ->update(['parent_id' => $parentId]);
                    $updated++;
                } else {
                    $skipped++;
                }
            }
        }
        
        echo "Migration completed: Updated {$updated} posts, skipped {$skipped} invalid references\n";
    },
    
    'down' => function (Builder $schema) {
        // Revert by setting all parent_id back to NULL for migrated posts
        $connection = $schema->getConnection();
        
        $connection->table('posts')
            ->whereNotNull('parent_id')
            ->update(['parent_id' => null]);
        
        echo "Reverted: Set all parent_id values back to NULL\n";
    }
];

function extractParentFromContent($content) {
    if (!$content) return null;
    
    // Look for <POSTMENTION id="X"> pattern
    if (preg_match('/<POSTMENTION[^>]+id="(\d+)"[^>]*>/', $content, $matches)) {
        return (int)$matches[1];
    }
    
    // Look for PostMention data-id pattern  
    if (preg_match('/<[^>]+class="[^"]*PostMention[^"]*"[^>]+data-id="(\d+)"[^>]*>/', $content, $matches)) {
        return (int)$matches[1];
    }
    
    // Look for @"username"#pX pattern and extract X
    if (preg_match('/@"[^"]*"#p(\d+)/', $content, $matches)) {
        return (int)$matches[1];
    }
    
    return null;
}
