<?php

use Illuminate\Database\Schema\Builder;
use SyntaxOutlaw\Threadify\Model\ThreadifyThread;

return [
    'up' => function (Builder $schema) {
        $connection = $schema->getConnection();
        
        echo "Populating threadify_threads table from existing parent_id data...\n";
        
        // Get all posts ordered by discussion and creation time
        $posts = $connection->table('posts')
            ->where('type', 'comment')
            ->orderBy('discussion_id')
            ->orderBy('created_at')
            ->get();
        
        $processedCount = 0;
        $errorCount = 0;
        
        foreach ($posts as $post) {
            try {
                // Skip if thread entry already exists
                $exists = $connection->table('threadify_threads')
                    ->where('post_id', $post->id)
                    ->exists();
                    
                if ($exists) {
                    continue;
                }
                
                // Calculate thread data
                $parentId = $post->parent_id;
                $threadData = calculateThreadData($connection, $post, $parentId);
                
                // Insert thread entry
                $connection->table('threadify_threads')->insert([
                    'discussion_id' => $post->discussion_id,
                    'post_id' => $post->id,
                    'parent_post_id' => $parentId,
                    'root_post_id' => $threadData['root_post_id'],
                    'depth' => $threadData['depth'],
                    'thread_path' => $threadData['thread_path'],
                    'child_count' => 0, // Will be calculated after all posts are inserted
                    'descendant_count' => 0, // Will be calculated after all posts are inserted
                    'created_at' => $post->created_at,
                    'updated_at' => $post->created_at, // Use created_at since updated_at may not exist
                ]);
                
                $processedCount++;
                
                if ($processedCount % 100 === 0) {
                    echo "Processed {$processedCount} posts...\n";
                }
                
            } catch (\Exception $e) {
                $errorCount++;
                echo "Error processing post {$post->id}: " . $e->getMessage() . "\n";
            }
        }
        
        echo "Phase 1 complete: Processed {$processedCount} posts with {$errorCount} errors\n";
        
        // Phase 2: Update child and descendant counts
        echo "Calculating child and descendant counts...\n";
        updateThreadCounts($connection);
        
        echo "Migration completed successfully!\n";
    },
    
    'down' => function (Builder $schema) {
        // Clear the threadify_threads table
        $connection = $schema->getConnection();
        $connection->table('threadify_threads')->truncate();
        echo "Cleared threadify_threads table\n";
    }
];

/**
 * Calculate thread data for a post
 */
function calculateThreadData($connection, $post, $parentId)
{
    if (!$parentId) {
        // Root post
        return [
            'root_post_id' => $post->id,
            'depth' => 0,
            'thread_path' => (string) $post->id
        ];
    }
    
    // Find parent thread data
    $parentThread = $connection->table('threadify_threads')
        ->where('post_id', $parentId)
        ->first();
    
    if (!$parentThread) {
        // Parent doesn't exist in threads table yet, treat as root
        // This can happen if posts are not processed in perfect order
        return [
            'root_post_id' => $post->id,
            'depth' => 0,
            'thread_path' => (string) $post->id
        ];
    }
    
    return [
        'root_post_id' => $parentThread->root_post_id,
        'depth' => $parentThread->depth + 1,
        'thread_path' => $parentThread->thread_path . '/' . $post->id
    ];
}

/**
 * Update child and descendant counts for all thread entries
 */
function updateThreadCounts($connection)
{
    // MySQL-compatible way to update child counts
    $connection->statement("
        UPDATE threadify_threads t1
        INNER JOIN (
            SELECT parent_post_id, COUNT(*) as count
            FROM threadify_threads 
            WHERE parent_post_id IS NOT NULL
            GROUP BY parent_post_id
        ) t2 ON t1.post_id = t2.parent_post_id
        SET t1.child_count = t2.count
    ");
    
    // MySQL-compatible way to update descendant counts
    $connection->statement("
        UPDATE threadify_threads t1
        INNER JOIN (
            SELECT 
                SUBSTRING_INDEX(thread_path, '/', 1) as root_post_id,
                COUNT(*) - 1 as count
            FROM threadify_threads 
            GROUP BY SUBSTRING_INDEX(thread_path, '/', 1)
        ) t2 ON t1.post_id = t2.root_post_id
        SET t1.descendant_count = t2.count
        WHERE t1.parent_post_id IS NULL
    ");
    
    // For non-root posts, calculate descendants differently
    $threads = $connection->table('threadify_threads')
        ->where('parent_post_id', '!=', null)
        ->get();
        
    foreach ($threads as $thread) {
        $descendantCount = $connection->table('threadify_threads')
            ->where('thread_path', 'LIKE', $thread->thread_path . '/%')
            ->count();
            
        $connection->table('threadify_threads')
            ->where('id', $thread->id)
            ->update(['descendant_count' => $descendantCount]);
    }
    
    echo "Updated child and descendant counts\n";
} 