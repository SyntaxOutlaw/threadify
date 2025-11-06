<?php

use Illuminate\Database\Schema\Builder;
use Illuminate\Database\Schema\Blueprint;

return [
    'up' => function (Builder $schema) {
        if ($schema->hasTable('threadify_threads')) return;

        $schema->create('threadify_threads', function (Blueprint $table) {
            $table->increments('id');

            $table->unsignedInteger('discussion_id');
            $table->unsignedInteger('post_id');
            $table->unsignedInteger('parent_post_id')->nullable();
            $table->unsignedInteger('root_post_id');

            $table->unsignedSmallInteger('depth')->default(0);
            // 保持较长但不建索引，避免 utf8mb4 前缀索引报错
            $table->string('thread_path', 1024);

            $table->unsignedInteger('child_count')->default(0);
            $table->unsignedInteger('descendant_count')->default(0);

            $table->timestamps();

            // 仅建常规索引，避免外键
            $table->unique('post_id');
            $table->index('discussion_id');
            $table->index('parent_post_id');
            $table->index('root_post_id');
            // 不对 thread_path 建索引；如将来需要性能，可引入辅助列 path_hash 再索引
        });
    },

    'down' => function (Builder $schema) {
        if ($schema->hasTable('threadify_threads')) {
            $schema->drop('threadify_threads');
        }
    },
];
