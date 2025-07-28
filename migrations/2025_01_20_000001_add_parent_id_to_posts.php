<?php


use Illuminate\Database\Schema\Blueprint;
use Illuminate\Database\Schema\Builder;

return [
    'up' => function (Builder $schema) {
        // Check if the column already exists to avoid errors
        if (!$schema->hasColumn('posts', 'parent_id')) {
            $schema->table('posts', function (Blueprint $table) {
                $table->unsignedInteger('parent_id')->nullable()->after('discussion_id');
            });
            echo "Added parent_id column to posts table\n";
        } else {
            echo "parent_id column already exists in posts table\n";
        }
    },
    
    'down' => function (Builder $schema) {
        $schema->table('posts', function (Blueprint $table) {
            $table->dropColumn('parent_id');
        });
    }
];
