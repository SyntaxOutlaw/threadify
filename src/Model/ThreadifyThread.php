<?php

namespace SyntaxOutlaw\Threadify\Model;

use Flarum\Database\AbstractModel;
use Flarum\Post\Post;
use Flarum\Discussion\Discussion;

class ThreadifyThread extends AbstractModel
{
    protected $table = 'threadify_threads';
    
    /**
     * Get the table name with proper prefix
     */
    public function getTable()
    {
        return $this->getConnection()->getTablePrefix() . 'threadify_threads';
    }
    
    protected $fillable = [
        'discussion_id',
        'post_id', 
        'parent_post_id',
        'root_post_id',
        'depth',
        'thread_path',
        'child_count',
        'descendant_count'
    ];
    
    protected $casts = [
        'discussion_id' => 'integer',
        'post_id' => 'integer',
        'parent_post_id' => 'integer', 
        'root_post_id' => 'integer',
        'depth' => 'integer',
        'child_count' => 'integer',
        'descendant_count' => 'integer',
        'created_at' => 'datetime',
        'updated_at' => 'datetime'
    ];
    
    /**
     * Relationship to the post this thread entry represents
     */
    public function post()
    {
        return $this->belongsTo(Post::class, 'post_id');
    }
    
    /**
     * Relationship to the parent post
     */
    public function parentPost()
    {
        return $this->belongsTo(Post::class, 'parent_post_id');
    }
    
    /**
     * Relationship to the root post of this thread
     */
    public function rootPost()
    {
        return $this->belongsTo(Post::class, 'root_post_id');
    }
    
    /**
     * Relationship to the discussion
     */
    public function discussion()
    {
        return $this->belongsTo(Discussion::class, 'discussion_id');
    }
    
    /**
     * Get all direct children of this thread entry
     */
    public function children()
    {
        return $this->hasMany(self::class, 'parent_post_id', 'post_id')
            ->orderBy('thread_path');
    }
    
    /**
     * Get all descendants (children, grandchildren, etc.) of this thread entry
     */
    public function descendants()
    {
        return self::where('thread_path', 'LIKE', $this->thread_path . '/%')
            ->orderBy('thread_path');
    }
    
    /**
     * Create a thread entry for a new post
     */
    public static function createForPost(Post $post, ?int $parentId = null): self
    {
        $discussionId = $post->discussion_id;
        
        if (!$parentId) {
            // Root post
            $threadPath = (string) $post->id;
            $rootPostId = $post->id;
            $depth = 0;
        } else {
            // Child post - find parent thread entry
            $parentThread = self::where('post_id', $parentId)->first();
            
            if (!$parentThread) {
                // Parent doesn't exist in threads table, treat as root
                $threadPath = (string) $post->id;
                $rootPostId = $post->id;
                $depth = 0;
            } else {
                $threadPath = $parentThread->thread_path . '/' . $post->id;
                $rootPostId = $parentThread->root_post_id;
                $depth = $parentThread->depth + 1;
            }
        }
        
        $threadEntry = self::create([
            'discussion_id' => $discussionId,
            'post_id' => $post->id,
            'parent_post_id' => $parentId,
            'root_post_id' => $rootPostId,
            'depth' => $depth,
            'thread_path' => $threadPath,
            'child_count' => 0,
            'descendant_count' => 0
        ]);
        
        // Update parent's child count
        if ($parentId) {
            self::where('post_id', $parentId)->increment('child_count');
            
            // Update all ancestors' descendant count
            self::updateAncestorCounts($threadEntry);
        }
        
        return $threadEntry;
    }
    
    /**
     * Update descendant counts for all ancestors of this thread entry
     */
    private static function updateAncestorCounts(self $threadEntry): void
    {
        $pathParts = explode('/', $threadEntry->thread_path);
        
        // Remove the last part (current post) to get ancestor paths
        array_pop($pathParts);
        
        // Update each ancestor's descendant count
        while (!empty($pathParts)) {
            $ancestorPath = implode('/', $pathParts);
            
            self::where('discussion_id', $threadEntry->discussion_id)
                ->where('thread_path', $ancestorPath)
                ->increment('descendant_count');
                
            array_pop($pathParts);
        }
    }
    
    /**
     * Get all threads for a discussion in proper threaded order
     */
    public static function getDiscussionThreads(int $discussionId)
    {
        return self::where('discussion_id', $discussionId)
            ->with(['post', 'post.user'])
            ->orderBy('thread_path')
            ->get();
    }
    
    /**
     * Get a specific thread branch (post + all descendants)
     */
    public static function getThreadBranch(int $postId)
    {
        $thread = self::where('post_id', $postId)->first();
        
        if (!$thread) {
            return collect();
        }
        
        return self::where('discussion_id', $thread->discussion_id)
            ->where(function($query) use ($thread) {
                $query->where('thread_path', $thread->thread_path)
                      ->orWhere('thread_path', 'LIKE', $thread->thread_path . '/%');
            })
            ->with(['post', 'post.user'])
            ->orderBy('thread_path')
            ->get();
    }
    
    /**
     * Check if this post is an ancestor of another post
     */
    public function isAncestorOf(int $postId): bool
    {
        $childThread = self::where('post_id', $postId)->first();
        
        if (!$childThread) {
            return false;
        }
        
        return str_starts_with($childThread->thread_path, $this->thread_path . '/');
    }
    
    /**
     * Check if this post is a descendant of another post
     */
    public function isDescendantOf(int $postId): bool
    {
        $parentThread = self::where('post_id', $postId)->first();
        
        if (!$parentThread) {
            return false;
        }
        
        return str_starts_with($this->thread_path, $parentThread->thread_path . '/');
    }
} 