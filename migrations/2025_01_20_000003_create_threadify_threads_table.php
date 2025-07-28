<?php

use Illuminate\Database\Schema\Blueprint;
use Illuminate\Database\Schema\Builder;

return [
    'up' => function (Builder $schema) {
        $schema->create('threadify_threads', function (Blueprint $table) {
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
    },
    
    'down' => function (Builder $schema) {
        $schema->dropIfExists('threadify_threads');
    }
]; 