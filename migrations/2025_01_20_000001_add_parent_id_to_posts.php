<?php

use Illuminate\Database\Schema\Blueprint;
use Illuminate\Database\Schema\Builder;

return [
    'up' => function (Builder $schema) {
        if (! $schema->hasColumn('posts', 'parent_id')) {
            $schema->table('posts', function (Blueprint $table) {
                $table->unsignedInteger('parent_id')->nullable()->after('discussion_id');
                $table->index('parent_id');
            });
        }
    },

    'down' => function (Builder $schema) {
        if ($schema->hasColumn('posts', 'parent_id')) {
            $schema->table('posts', function (Blueprint $table) {
                $table->dropIndex(['parent_id']);
                $table->dropColumn('parent_id');
            });
        }
    },
];
