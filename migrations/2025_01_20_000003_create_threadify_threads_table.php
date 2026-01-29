<?php

use Illuminate\Database\Schema\Builder;
use Illuminate\Database\Schema\Blueprint;

return [
    'up' => function (Builder $schema) {
        $connection = $schema->getConnection();
        $prefix = $connection->getTablePrefix();
        $threadsTable = 'threadify_threads';
        $postsTable = 'posts';
        $discussionsTable = 'discussions';

        // These are prefix-safe because Schema Builder applies prefix internally.
        if (!$schema->hasTable($postsTable) || !$schema->hasTable($discussionsTable)) {
            resolve('log')->error('[Threadify] Required Flarum tables missing ('.$prefix.$postsTable.'/'.$prefix.$discussionsTable.'). Is Flarum installed?');
            return;
        }

        if ($schema->hasTable($threadsTable)) {
            resolve('log')->info('[Threadify] '.$prefix.$threadsTable.' already exists; skipping creation.');
            return;
        }

        resolve('log')->info('[Threadify] Creating '.$prefix.$threadsTable.' table…');

        try {
            $schema->create($threadsTable, function (Blueprint $table) {
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

                // Indexes
                $table->index('discussion_id');
                $table->unique('post_id');
                $table->index('parent_post_id');
                $table->index('root_post_id');
                $table->index('thread_path');
                $table->index(['discussion_id', 'thread_path']);
            });

            // Add FKs in a separate step (cleaner + avoids edge cases during create)
            $schema->table($threadsTable, function (Blueprint $table) {
                $table->foreign('discussion_id')->references('id')->on('discussions')->onDelete('cascade');

                $table->foreign('post_id')->references('id')->on('posts')->onDelete('cascade');
                $table->foreign('parent_post_id')->references('id')->on('posts')->onDelete('cascade');
                $table->foreign('root_post_id')->references('id')->on('posts')->onDelete('cascade');
            });

            resolve('log')->info('[Threadify] '.$prefix.$threadsTable.' created successfully.');
        } catch (\Throwable $e) {
            resolve('log')->error('[Threadify] Error creating '.$prefix.$threadsTable.': ' . $e->getMessage());
            throw $e; // Let Flarum show a proper error rather than silently “succeed”
        }
    },

    'down' => function (Builder $schema) {
        $connection = $schema->getConnection();
        $prefix = $connection->getTablePrefix();
        $threadsTable = 'threadify_threads';
        // Drop table (Schema Builder handles prefixes)
        if ($schema->hasTable($threadsTable)) {
            try {
                $schema->table($threadsTable, function (Blueprint $table) {
                    $table->dropForeign(['discussion_id']);
                    $table->dropForeign(['post_id']);
                    $table->dropForeign(['parent_post_id']);
                    $table->dropForeign(['root_post_id']);
                });
            } catch (\Throwable $e) {
                resolve('log')->warning('[Threadify] Could not drop foreign keys before drop on '.$prefix.$threadsTable.' table: ' . $e->getMessage());
            }

            $schema->dropIfExists($threadsTable);
            resolve('log')->info('[Threadify] Dropped '.$prefix.$threadsTable.' table.');
        }
    }
];
