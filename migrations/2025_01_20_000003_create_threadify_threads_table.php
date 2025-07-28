<?php

use Illuminate\Database\Schema\Builder;
use Illuminate\Database\Schema\Blueprint;

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
        $tableName = 'threadify_threads';
        
        // Check if required Flarum tables exist
        if (!$schema->hasTable('posts')) {
            echo "Error: posts table does not exist. This extension requires Flarum to be properly installed.\n";
            return;
        }
        
        if (!$schema->hasTable('discussions')) {
            echo "Error: discussions table does not exist. This extension requires Flarum to be properly installed.\n";
            return;
        }
        
        // Check if the table already exists
        try {
            $connection->select("SELECT 1 FROM {$tableName} LIMIT 1");
            echo "Table {$tableName} already exists, skipping creation.\n";
            return;
        } catch (\Exception $e) {
            // Table doesn't exist, proceed with creation
        }
        
        echo "Creating {$tableName} table...\n";
        
        try {
            // Create the table
            $schema->create('threadify_threads', function ($table) use ($schema) {
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
                
                // Foreign key constraints - only add if the referenced tables exist
                if ($schema->hasTable('discussions')) {
                    $table->foreign('discussion_id')->references('id')->on('discussions')->onDelete('cascade');
                }
                if ($schema->hasTable('posts')) {
                    $table->foreign('post_id')->references('id')->on('posts')->onDelete('cascade');
                    $table->foreign('parent_post_id')->references('id')->on('posts')->onDelete('cascade');
                    $table->foreign('root_post_id')->references('id')->on('posts')->onDelete('cascade');
                }
                
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
            
            echo "✅ {$tableName} table created successfully.\n";
        } catch (\Exception $e) {
            echo "❌ Error creating {$tableName} table: " . $e->getMessage() . "\n";
            return;
        }
    },
    
    'down' => function (Builder $schema) {
        // Drop the threadify_threads table completely
        if ($schema->hasTable('threadify_threads')) {
            $schema->drop('threadify_threads');
            echo "Dropped threadify_threads table\n";
        }
    }
]; 