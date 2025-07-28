<?php

namespace SyntaxOutlaw\Threadify\Api\Controller;

use Flarum\Http\RequestUtil;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Laminas\Diactoros\Response\JsonResponse;
use Illuminate\Database\ConnectionInterface;

class RebuildParentIdsController implements RequestHandlerInterface
{
    public function handle(ServerRequestInterface $request): ResponseInterface
    {
        $actor = RequestUtil::getActor($request);
        $actor->assertAdmin();

        $db = resolve(ConnectionInterface::class);
        $results = [];

        // --- PART 1: Populate parent_id in posts ---
        $posts = $db->table('posts')
            ->whereNull('parent_id')
            ->where('type', 'comment')
            ->get();
        $updated = 0;
        $skipped = 0;
        foreach ($posts as $post) {
            $parentId = self::extractParentFromContent($post->content);
            if ($parentId) {
                $parentExists = $db->table('posts')
                    ->where('id', $parentId)
                    ->where('discussion_id', $post->discussion_id)
                    ->exists();
                if ($parentExists) {
                    $db->table('posts')->where('id', $post->id)->update(['parent_id' => $parentId]);
                    $updated++;
                } else {
                    $skipped++;
                }
            }
        }
        $results['parent_id_updated'] = $updated;
        $results['parent_id_skipped'] = $skipped;

        // --- PART 2: Rebuild threadify_threads ---
        $tableName = 'threadify_threads';
        $db->table($tableName)->truncate();
        
        // First pass: Insert all posts with basic data
        $posts = $db->table('posts')
            ->where('type', 'comment')
            ->orderBy('discussion_id')
            ->orderBy('created_at')
            ->get();
        $processedCount = 0;
        $errorCount = 0;
        
        foreach ($posts as $post) {
            try {
                $parentId = $post->parent_id;
                $threadData = self::calculateThreadData($db, $post, $parentId, $tableName);
                $db->table($tableName)->insert([
                    'discussion_id' => $post->discussion_id,
                    'post_id' => $post->id,
                    'parent_post_id' => $parentId,
                    'root_post_id' => $threadData['root_post_id'],
                    'depth' => $threadData['depth'],
                    'thread_path' => $threadData['thread_path'],
                    'child_count' => 0,
                    'descendant_count' => 0,
                    'created_at' => $post->created_at,
                    'updated_at' => $post->created_at,
                ]);
                $processedCount++;
            } catch (\Exception $e) {
                $errorCount++;
            }
        }
        $results['threads_processed'] = $processedCount;
        $results['threads_errors'] = $errorCount;

        // --- PART 3: Update child and descendant counts ---
        // Update child counts
        $db->statement("
            UPDATE {$tableName} t1
            INNER JOIN (
                SELECT parent_post_id, COUNT(*) as count
                FROM {$tableName} 
                WHERE parent_post_id IS NOT NULL
                GROUP BY parent_post_id
            ) t2 ON t1.post_id = t2.parent_post_id
            SET t1.child_count = t2.count
        ");
        
        // Update descendant counts for root posts
        $db->statement("
            UPDATE {$tableName} t1
            INNER JOIN (
                SELECT 
                    root_post_id,
                    COUNT(*) - 1 as count
                FROM {$tableName} 
                GROUP BY root_post_id
            ) t2 ON t1.post_id = t2.root_post_id
            SET t1.descendant_count = t2.count
            WHERE t1.parent_post_id IS NULL
        ");
        
        // Update descendant counts for non-root posts
        $threads = $db->table('threadify_threads')->whereNotNull('parent_post_id')->get();
        foreach ($threads as $thread) {
            $descendantCount = $db->table('threadify_threads')
                ->where('thread_path', 'LIKE', $thread->thread_path . '/%')
                ->count();
            $db->table('threadify_threads')
                ->where('id', $thread->id)
                ->update(['descendant_count' => $descendantCount]);
        }
        $results['child_descendant_counts_updated'] = true;

        return new JsonResponse(['status' => 'ok', 'results' => $results]);
    }

    private static function extractParentFromContent($content)
    {
        if (!$content) return null;
        if (preg_match('/<POSTMENTION[^>]+id=\"(\d+)\"[^>]*>/', $content, $matches)) {
            return (int)$matches[1];
        }
        if (preg_match('/<[^>]+class=\"[^\"]*PostMention[^\"]*\"[^>]+data-id=\"(\d+)\"[^>]*>/', $content, $matches)) {
            return (int)$matches[1];
        }
        if (preg_match('/@\"[^\"]*\"#p(\d+)/', $content, $matches)) {
            return (int)$matches[1];
        }
        return null;
    }

    private static function calculateThreadData($db, $post, $parentId, $tableName)
    {
        if (!$parentId) {
            return [
                'root_post_id' => $post->id,
                'depth' => 0,
                'thread_path' => (string) $post->id
            ];
        }
        
        // Find the parent post to get its thread data
        $parentPost = $db->table('posts')
            ->where('id', $parentId)
            ->first();
            
        if (!$parentPost) {
            return [
                'root_post_id' => $post->id,
                'depth' => 0,
                'thread_path' => (string) $post->id
            ];
        }
        
        // If parent has no parent_id, it's a root post
        if (!$parentPost->parent_id) {
            return [
                'root_post_id' => $parentId,
                'depth' => 1,
                'thread_path' => $parentId . '/' . $post->id
            ];
        }
        
        // Recursively find the root post
        $rootPostId = self::findRootPostId($db, $parentId);
        $depth = self::calculateDepth($db, $parentId) + 1;
        $threadPath = self::buildThreadPath($db, $parentId) . '/' . $post->id;
        
        return [
            'root_post_id' => $rootPostId,
            'depth' => $depth,
            'thread_path' => $threadPath
        ];
    }
    
    private static function findRootPostId($db, $postId)
    {
        $currentPostId = $postId;
        while (true) {
            $post = $db->table('posts')->where('id', $currentPostId)->first();
            if (!$post || !$post->parent_id) {
                return $currentPostId;
            }
            $currentPostId = $post->parent_id;
        }
    }
    
    private static function calculateDepth($db, $postId)
    {
        $depth = 0;
        $currentPostId = $postId;
        while (true) {
            $post = $db->table('posts')->where('id', $currentPostId)->first();
            if (!$post || !$post->parent_id) {
                break;
            }
            $depth++;
            $currentPostId = $post->parent_id;
        }
        return $depth;
    }
    
    private static function buildThreadPath($db, $postId)
    {
        $path = [];
        $currentPostId = $postId;
        while (true) {
            $post = $db->table('posts')->where('id', $currentPostId)->first();
            if (!$post) {
                break;
            }
            array_unshift($path, $currentPostId);
            if (!$post->parent_id) {
                break;
            }
            $currentPostId = $post->parent_id;
        }
        return implode('/', $path);
    }
} 