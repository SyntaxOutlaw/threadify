<?php

use Illuminate\Database\Schema\Builder;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Database\ConnectionInterface;

/**
 * Compute root/depth/path.
 * Assumes parent thread row may not exist yet; falls back to root.
 */
function calculateThreadData(ConnectionInterface $connection, string $threadsTable, $postId, $parentId): array
{
    if (!$parentId) {
        return [
            'root_post_id' => $postId,
            'depth' => 0,
            'thread_path' => (string) $postId,
        ];
    }

    $parentThread = $connection->table($threadsTable)
        ->select(['root_post_id', 'depth', 'thread_path'])
        ->where('post_id', $parentId)
        ->first();

    if (!$parentThread) {
        return [
            'root_post_id' => $postId,
            'depth' => 0,
            'thread_path' => (string) $postId,
        ];
    }

    return [
        'root_post_id' => (int) $parentThread->root_post_id,
        'depth' => (int) $parentThread->depth + 1,
        'thread_path' => $parentThread->thread_path . '/' . $postId,
    ];
}

/**
 * Update child_count and descendant_count.
 * (Still not perfect-big-O, but much safer + no echo)
 */
function updateThreadCounts(ConnectionInterface $connection, string $threadsTable): void
{
    $prefix = $connection->getTablePrefix();
    // Reset counts first to make it re-runnable
    $connection->table($threadsTable)->update([
        'child_count' => 0,
        'descendant_count' => 0,
    ]);

    // child_count: count direct children grouped by parent_post_id
    $childCounts = $connection->table($threadsTable)
        ->selectRaw('parent_post_id, COUNT(*) as cnt')
        ->whereNotNull('parent_post_id')
        ->groupBy('parent_post_id')
        ->get();

    foreach ($childCounts as $row) {
        $connection->table($threadsTable)
            ->where('post_id', $row->parent_post_id)
            ->update(['child_count' => (int) $row->cnt]);
    }

    // descendant_count: for each row, count rows whose path starts with its path + '/'
    // Note: This is O(n²) in worst case; fine for small forums, but we can optimize later if needed.
    $connection->table($threadsTable)
        ->select(['id', 'thread_path'])
        ->orderBy('id')
        ->chunkById(500, function ($threads) use ($connection, $threadsTable) {
            foreach ($threads as $t) {
                $desc = $connection->table($threadsTable)
                    ->where('thread_path', 'LIKE', $t->thread_path . '/%')
                    ->count();

                $connection->table($threadsTable)
                    ->where('id', $t->id)
                    ->update(['descendant_count' => (int) $desc]);
            }
        });

    resolve('log')->info('[Threadify] Updated child_count and descendant_count on '.$prefix.$threadsTable.' table');
}

return [
    'up' => function (Builder $schema) {
        $connection = $schema->getConnection();
        $prefix = $connection->getTablePrefix();
        $threadsTable = 'threadify_threads';
        $postsTable   = 'posts';

        // Ensure prerequisite tables exist (Schema Builder is prefix-safe)
        if (!$schema->hasTable($threadsTable)) {
            resolve('log')->error('[Threadify] '.$prefix.'threadify_threads table missing. Run the create_threadify_threads migration first.');
            return;
        }

        if (!$schema->hasTable($postsTable)) {
            resolve('log')->error('[Threadify] '.$prefix.'posts table missing. Is Flarum installed?');
            return;
        }

        // Ensure parent_id exists (Schema Builder prefix-safe)
        if (!$schema->hasColumn($postsTable, 'parent_id')) {
            resolve('log')->error('[Threadify] '.$prefix.$postsTable.'.parent_id missing. Run the add_parent_id migration first.');
            return;
        }

        resolve('log')->info('[Threadify] Populating '.$prefix.$threadsTable.' from '.$prefix.$postsTable.'.parent_id…');

        $processed = 0;
        $skippedExisting = 0;
        $errors = 0;

        // Iterate posts in chunks to avoid loading everything
        $connection->table($postsTable)
            ->select(['id', 'discussion_id', 'parent_id', 'created_at'])
            ->where('type', 'comment')
            ->orderBy('discussion_id')
            ->orderBy('created_at')
            ->chunk(500, function ($posts) use (
                $connection,
                $threadsTable,
                &$processed,
                &$skippedExisting,
                &$errors
            ) {
                foreach ($posts as $post) {
                    try {
                        // Skip if already exists
                        $exists = $connection->table($threadsTable)
                            ->where('post_id', $post->id)
                            ->exists();

                        if ($exists) {
                            $skippedExisting++;
                            continue;
                        }

                        $threadData = calculateThreadData(
                            $connection,
                            $threadsTable,
                            (int) $post->id,
                            $post->parent_id ? (int) $post->parent_id : null
                        );

                        $connection->table($threadsTable)->insert([
                            'discussion_id'     => (int) $post->discussion_id,
                            'post_id'           => (int) $post->id,
                            'parent_post_id'    => $post->parent_id ? (int) $post->parent_id : null,
                            'root_post_id'      => (int) $threadData['root_post_id'],
                            'depth'             => (int) $threadData['depth'],
                            'thread_path'       => (string) $threadData['thread_path'],
                            'child_count'       => 0,
                            'descendant_count'  => 0,
                            'created_at'        => $post->created_at,
                            'updated_at'        => $post->created_at,
                        ]);

                        $processed++;
                    } catch (\Throwable $e) {
                        $errors++;
                        resolve('log')->warning('[Threadify] Error processing post '.$prefix.$postsTable.'.id='.$post->id.': '.$e->getMessage());

                        if ($errors > 50) {
                            // Hard stop if it’s going sideways
                            throw $e;
                        }
                    }
                }
            });

        resolve('log')->info("[Threadify] Insert phase complete. inserted={$processed}, skippedExisting={$skippedExisting}, errors={$errors} on {$prefix}{$threadsTable} table");

        // Update counts
        updateThreadCounts($connection, $threadsTable);

        resolve('log')->info('[Threadify] Population migration completed on '.$prefix.$threadsTable.' table');
    },

    'down' => function (Builder $schema) {
        $connection = $schema->getConnection();
        $prefix = $connection->getTablePrefix();
        $threadsTable = 'threadify_threads';

        if (!$schema->hasTable($threadsTable)) {
            resolve('log')->info('[Threadify] '.$prefix.$threadsTable.' missing on down(); nothing to clear.');
            return;
        }

        try {
            // TRUNCATE can fail with FKs; delete is safer
            $deleted = $connection->table($threadsTable)->delete();
            resolve('log')->info("[Threadify] Cleared {$deleted} rows from ".$prefix.$threadsTable.".");
        } catch (\Throwable $e) {
            resolve('log')->error('[Threadify] Failed to clear '.$prefix.$threadsTable.': ' . $e->getMessage());
            throw $e;
        }
    }
];
