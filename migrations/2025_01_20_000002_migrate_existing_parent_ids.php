<?php

use Illuminate\Database\Schema\Builder;

function extractParentFromContent($content): ?int {
    if (!$content) return null;

    // <POSTMENTION id="X">
    if (preg_match('/<POSTMENTION[^>]+id="(\d+)"[^>]*>/', $content, $m)) {
        return (int) $m[1];
    }

    // class="...PostMention..." data-id="X"
    if (preg_match('/<[^>]+class="[^"]*PostMention[^"]*"[^>]+data-id="(\d+)"[^>]*>/', $content, $m)) {
        return (int) $m[1];
    }

    // @"username"#pX
    if (preg_match('/@"[^"]*"#p(\d+)/', $content, $m)) {
        return (int) $m[1];
    }

    return null;
}

return [
    'up' => function (Builder $schema) {
        $connection = $schema->getConnection();
        $postsTable = 'posts';
        $prefix = $connection->getTablePrefix();

        // Schema checks are prefix-safe already, keep them
        if (!$schema->hasColumn('posts', 'parent_id')) {
            resolve('log')->error('[Threadify] parent_id column missing on '.$prefix.$postsTable.' table; run the add_parent_id migration first.');
            return;
        }

        $updated = 0;
        $skipped = 0;

        // Chunk to avoid loading everything at once
        $connection->table($postsTable)
            ->select(['id', 'discussion_id', 'content'])
            ->whereNull('parent_id')
            ->where('type', 'comment')
            ->orderBy('id')
            ->chunkById(500, function ($posts) use ($connection, $postsTable, &$updated, &$skipped) {
                foreach ($posts as $post) {
                    try {
                        $parentId = extractParentFromContent($post->content);

                        if (!$parentId) {
                            continue;
                        }

                        // Verify parent exists in same discussion
                        $parentExists = $connection->table($postsTable)
                            ->where('id', $parentId)
                            ->where('discussion_id', $post->discussion_id)
                            ->exists();

                        if (!$parentExists) {
                            $skipped++;
                            continue;
                        }

                        $connection->table($postsTable)
                            ->where('id', $post->id)
                            ->update(['parent_id' => $parentId]);

                        $updated++;
                    } catch (\Throwable $e) {
                        $skipped++;
                        resolve('log')->warning("[Threadify] Error processing post {$prefix}{$postsTable}.id={$post->id}: {$e->getMessage()}");
                    }
                }
            });

        resolve('log')->info("[Threadify] Parent extraction migration complete. Updated={$updated}, skipped={$skipped} on {$prefix}{$postsTable} table");
    },

    'down' => function (Builder $schema) {
        $connection = $schema->getConnection();
        $postsTable = 'posts';
        $prefix = $connection->getTablePrefix();
        $affected = $connection->table($postsTable)
            ->whereNotNull('parent_id')
            ->update(['parent_id' => null]);

        resolve('log')->info("[Threadify] Reverted parent_id to NULL on {$affected} posts on {$prefix}{$postsTable} table");
    }
];
