<?php

namespace SyntaxOutlaw\Threadify\Api\Controller;

use Flarum\Admin\Controller\AbstractAdminController;
use Psr\Http\Message\ServerRequestInterface;
use Laminas\Diactoros\Response\JsonResponse;
use Illuminate\Database\ConnectionInterface;

class RebuildParentIdsController extends AbstractAdminController
{
    protected function handle(ServerRequestInterface $request)
    {
        $actor = $request->getAttribute('actor');
        if (!$actor || !$actor->isAdmin()) {
            return new JsonResponse(['error' => 'Permission denied'], 403);
        }

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
        $db->table('threadify_threads')->truncate();
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
                $threadData = self::calculateThreadData($db, $post, $parentId);
                $db->table('threadify_threads')->insert([
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
        // (copied from migration)
        $db->statement("
            UPDATE threadify_threads t1
            INNER JOIN (
                SELECT parent_post_id, COUNT(*) as count
                FROM threadify_threads 
                WHERE parent_post_id IS NOT NULL
                GROUP BY parent_post_id
            ) t2 ON t1.post_id = t2.parent_post_id
            SET t1.child_count = t2.count
        ");
        $db->statement("
            UPDATE threadify_threads t1
            INNER JOIN (
                SELECT 
                    SUBSTRING_INDEX(thread_path, '/', 1) as root_post_id,
                    COUNT(*) - 1 as count
                FROM threadify_threads 
                GROUP BY SUBSTRING_INDEX(thread_path, '/', 1)
            ) t2 ON t1.post_id = t2.root_post_id
            SET t1.descendant_count = t2.count
            WHERE t1.parent_post_id IS NULL
        ");
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

    private static function calculateThreadData($db, $post, $parentId)
    {
        if (!$parentId) {
            return [
                'root_post_id' => $post->id,
                'depth' => 0,
                'thread_path' => (string) $post->id
            ];
        }
        $parentThread = $db->table('threadify_threads')
            ->where('post_id', $parentId)
            ->first();
        if (!$parentThread) {
            return [
                'root_post_id' => $post->id,
                'depth' => 0,
                'thread_path' => (string) $post->id
            ];
        }
        return [
            'root_post_id' => $parentThread->root_post_id,
            'depth' => $parentThread->depth + 1,
            'thread_path' => $parentThread->thread_path . '/' . $post->id
        ];
    }
} 