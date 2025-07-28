<?php

use Illuminate\Database\Schema\Builder;
use Illuminate\Database\Schema\Blueprint;

// Helper functions for the migration
function calculateThreadData($connection, $post, $parentId, $tableName)
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
        $parentThread = $connection->table($tableName)
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
function updateThreadCounts($connection, $tableName)
{
    try {
        // Check if table exists before proceeding
        $connection->select("SELECT 1 FROM {$tableName} LIMIT 1");
        
        // MySQL-compatible way to update child counts
        $connection->statement("
            UPDATE {$tableName} t1
            INNER JOIN (
                SELECT parent_post_id, COUNT(*) as count
                FROM {$tableName} 
                WHERE parent_post_id IS NOT NULL
                GROUP BY parent_post_id
            ) t2 ON t1.post_id = t2.parent_post_id
            SET t1.child_count = t2.count
        ");
        
        // MySQL-compatible way to update descendant counts
        $connection->statement("
            UPDATE {$tableName} t1
            INNER JOIN (
                SELECT 
                    SUBSTRING_INDEX(thread_path, '/', 1) as root_post_id,
                    COUNT(*) - 1 as count
                FROM {$tableName} 
                GROUP BY SUBSTRING_INDEX(thread_path, '/', 1)
            ) t2 ON t1.post_id = t2.root_post_id
            SET t1.descendant_count = t2.count
            WHERE t1.parent_post_id IS NULL
        ");
        
        // For non-root posts, calculate descendants differently
        $threads = $connection->table($tableName)
            ->where('parent_post_id', '!=', null)
            ->get();
            
        foreach ($threads as $thread) {
            $descendantCount = $connection->table($tableName)
                ->where('thread_path', 'LIKE', $thread->thread_path . '/%')
                ->count();
                
            $connection->table($tableName)
                ->where('id', $thread->id)
                ->update(['descendant_count' => $descendantCount]);
        }
        
        echo "Updated child and descendant counts\n";
    } catch (\Exception $e) {
        echo "Error updating thread counts: " . $e->getMessage() . "\n";
    }
}

return [
    'up' => function (Builder $schema) {
        try {
            $connection = $schema->getConnection();
            
            // Test database connection
            $connection->getPdo();
            echo "Database connection successful\n";
        } catch (\Exception $e) {
            echo "Error connecting to database: " . $e->getMessage() . "\n";
            return;
        }
        
        // Get the proper table name with prefix
        $tableName = $schema->getConnection()->getTablePrefix() . 'threadify_threads';
        
        // Check if the threadify_threads table exists by trying to query it
        try {
            $connection->select("SELECT 1 FROM {$tableName} LIMIT 1");
            echo "✅ Table {$tableName} exists, proceeding with population.\n";
        } catch (\Exception $e) {
            echo "❌ Error: Table {$tableName} does not exist. Please ensure migration 2025_01_20_000003_create_threadify_threads_table.php has been run first.\n";
            echo "Error details: " . $e->getMessage() . "\n";
            return;
        }
        
        // Check if posts table has parent_id column
        if (!$schema->hasColumn('posts', 'parent_id')) {
            echo "Error: posts table does not have parent_id column. Please ensure migration 2025_01_20_000001_add_parent_id_to_posts.php has been run first.\n";
            echo "Attempting to add parent_id column...\n";
            
            try {
                $schema->table('posts', function (Blueprint $table) {
                    $table->unsignedInteger('parent_id')->nullable()->after('discussion_id');
                });
                echo "Successfully added parent_id column to posts table\n";
            } catch (\Exception $e) {
                echo "Error adding parent_id column: " . $e->getMessage() . "\n";
                return;
            }
        }
        
        echo "Populating {$tableName} table from existing parent_id data...\n";
        
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
                $exists = $connection->table($tableName)
                    ->where('post_id', $post->id)
                    ->exists();
                    
                if ($exists) {
                    continue;
                }
                
                // Calculate thread data
                $parentId = $post->parent_id;
                $threadData = calculateThreadData($connection, $post, $parentId, $tableName);
                
                // Insert thread entry
                $connection->table($tableName)->insert([
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
                
                if ($errorCount > 10) {
                    echo "Too many errors, stopping migration\n";
                    return;
                }
            }
        }
        
        echo "Phase 1 complete: Processed {$processedCount} posts with {$errorCount} errors\n";
        
        // Update thread counts
        updateThreadCounts($connection, $tableName);
        
        echo "✅ Migration completed successfully!\n";
    },
    
    'down' => function (Builder $schema) {
        // Clear the threadify_threads table
        $tableName = 'threadify_threads';
        
        try {
            if ($schema->hasTable($tableName)) {
                $schema->table($tableName, function (Blueprint $table) {
                    $table->truncate();
                });
                echo "Cleared {$tableName} table\n";
            }
        } catch (\Exception $e) {
            echo "Error truncating table {$tableName}: " . $e->getMessage() . "\n";
        }
    }
]; 