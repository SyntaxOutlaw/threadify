<?php

use Illuminate\Database\Schema\Builder;
use Illuminate\Database\Schema\Blueprint;
use SyntaxOutlaw\Threadify\Model\ThreadifyThread;

return [
    'up' => function (Builder $schema) {
        $connection = $schema->getConnection();
        
        // Ensure the threadify_threads table exists before proceeding
        if (!$schema->hasTable('threadify_threads')) {
            echo "Creating threadify_threads table first...\n";
            
            try {
                // Create the table if it doesn't exist
                $schema->create('threadify_threads', function ($table) {
                    $table->id();
                    $table->unsignedInteger('discussion_id');
                    $table->unsignedInteger('post_id');
                    $table->unsignedInteger('parent_post_id')->nullable();
                    $table->unsignedInteger('root_post_id');
                    $table->unsignedSmallInteger('depth')->default(0);
                    $table->string('thread_path', 500);
                    $table->unsignedInteger('child_count')->default(0);
                    $table->unsignedInteger('descendant_count')->default(0);
                    $table->timestamps();
                    
                    // Foreign key constraints
                    $table->foreign('discussion_id')->references('id')->on('discussions')->onDelete('cascade');
                    $table->foreign('post_id')->references('id')->on('posts')->onDelete('cascade');
                    $table->foreign('parent_post_id')->references('id')->on('posts')->onDelete('cascade');
                    $table->foreign('root_post_id')->references('id')->on('posts')->onDelete('cascade');
                    
                    // Indexes for performance
                    $table->index('discussion_id');
                    $table->index('post_id');
                    $table->index('parent_post_id');
                    $table->index('root_post_id');
                    $table->index('thread_path');
                    $table->index(['discussion_id', 'thread_path']); // Compound index for main query
                    
                    // Unique constraint - each post can only have one thread entry
                    $table->unique('post_id');
                });
                
                echo "threadify_threads table created successfully.\n";
            } catch (\Exception $e) {
                echo "Error creating threadify_threads table: " . $e->getMessage() . "\n";
                return;
            }
        }
        
        echo "Populating threadify_threads table from existing parent_id data...\n";
        
        // Check if posts table has parent_id column
        if (!$schema->hasColumn('posts', 'parent_id')) {
            echo "Error: posts table does not have parent_id column. Please ensure migration 2025_01_20_000001_add_parent_id_to_posts.php has been run first.\n";
            return;
        }
        
        try {
            // Get all posts ordered by discussion and creation time
            $posts = $connection->table('posts')
                ->where('type', 'comment')
                ->orderBy('discussion_id')
                ->orderBy('created_at')
                ->get();
        } catch (\Exception $e) {
            echo "Error fetching posts: " . $e->getMessage() . "\n";
            return;
        }
        
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
        // Drop the threadify_threads table completely
        if ($schema->hasTable('threadify_threads')) {
            $schema->drop('threadify_threads');
            echo "Dropped threadify_threads table\n";
        }
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
    
    try {
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
    } catch (\Exception $e) {
        // If there's any error accessing the table, treat as root
        return [
            'root_post_id' => $post->id,
            'depth' => 0,
            'thread_path' => (string) $post->id
        ];
    }
}

/**
 * Update child and descendant counts for all thread entries
 */
function updateThreadCounts($connection)
{
    try {
        // Check if table exists before proceeding
        if (!$connection->getSchemaBuilder()->hasTable('threadify_threads')) {
            echo "Error: threadify_threads table does not exist for count updates.\n";
            return;
        }
        
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
    } catch (\Exception $e) {
        echo "Error updating thread counts: " . $e->getMessage() . "\n";
    }
} 