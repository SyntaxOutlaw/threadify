<?php


use Illuminate\Database\Schema\Blueprint;
use Illuminate\Database\Schema\Builder;

return [
    'up' => function (Builder $schema) {
        $prefix = $schema->getConnection()->getTablePrefix();
        $postsTable = 'posts';
        // Check if the column already exists to avoid errors
        if (!$schema->hasColumn($postsTable, 'parent_id')) {
            $schema->table($postsTable, function (Blueprint $table) {
                $table->unsignedInteger('parent_id')->nullable()->after('discussion_id');
            });
            $prefix = $schema->getConnection()->getTablePrefix();
            resolve('log')->info('[Threadify] Added parent_id column to '.$prefix.$postsTable.' table');
        } else {
            resolve('log')->info('[Threadify] parent_id column already exists in '.$prefix.$postsTable.' table');
        }
    },
    
    'down' => function (Builder $schema) {
        $prefix = $schema->getConnection()->getTablePrefix();
        $postsTable = 'posts';
        if ($schema->hasColumn($postsTable, 'parent_id')) {
            $schema->table($postsTable, function (Blueprint $table) {
                $table->dropColumn('parent_id');
            });
            resolve('log')->info('[Threadify] Dropped parent_id column from '.$prefix.$postsTable.' table');
        } else {
            resolve('log')->info('[Threadify] parent_id column does not exist in '.$prefix.$postsTable.' table');
        }
    }
];
