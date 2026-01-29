<?php

namespace SyntaxOutlaw\Threadify\Api\Controller;

use Flarum\Http\RequestUtil;
use Illuminate\Database\ConnectionInterface;
use Laminas\Diactoros\Response\JsonResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;

class RebuildParentIdsController implements RequestHandlerInterface
{
    public function handle(ServerRequestInterface $request): ResponseInterface
    {
        $actor = RequestUtil::getActor($request);
        $actor->assertAdmin();

        /** @var ConnectionInterface $db */
        $db = resolve(ConnectionInterface::class);

        $postsTable = 'posts';
        $threadsTable = 'threadify_threads';
        $prefix = $db->getTablePrefix();

        $results = [];

        // PART 1: Populate parent_id in posts
        $updated = 0;
        $skipped = 0;

        resolve('log')->info('[Threadify] RebuildParentIdsController: Populating parent_id in '.$prefix.$postsTable.' table');

        $db->table($postsTable)
            ->select(['id', 'discussion_id', 'content'])
            ->whereNull('parent_id')
            ->where('type', 'comment')
            ->orderBy('id')
            ->chunkById(500, function ($posts) use ($db, $postsTable, &$updated, &$skipped) {
                foreach ($posts as $post) {
                    $parentId = self::extractParentFromContent($post->content);

                    if (!$parentId) {
                        continue;
                    }

                    $parentExists = $db->table($postsTable)
                        ->where('id', $parentId)
                        ->where('discussion_id', $post->discussion_id)
                        ->exists();

                    if (!$parentExists) {
                        $skipped++;
                        continue;
                    }

                    $db->table($postsTable)
                        ->where('id', $post->id)
                        ->update(['parent_id' => $parentId]);

                    $updated++;
                }
            });

        $results['parent_id_updated'] = $updated;
        $results['parent_id_skipped'] = $skipped;

        // PART 2: Rebuild threadify_threads
        // TRUNCATE can fail with FKs; delete is safer.
        resolve('log')->info('[Threadify] RebuildParentIdsController: Deleting '.$prefix.$threadsTable.' table');
        $deleted = $db->table($threadsTable)->delete();
        $results['threads_cleared'] = $deleted;

        $processedCount = 0;
        $errorCount = 0;

        $db->table($postsTable)
            ->select(['id', 'discussion_id', 'parent_id', 'created_at'])
            ->where('type', 'comment')
            ->orderBy('discussion_id')
            ->orderBy('created_at')
            ->chunk(500, function ($posts) use ($db, $postsTable, $threadsTable, &$processedCount, &$errorCount) {
                foreach ($posts as $post) {
                    try {
                        $parentId = $post->parent_id ? (int) $post->parent_id : null;
                        $threadData = self::calculateThreadData($db, $postsTable, $parentId, (int) $post->id);

                        $db->table($threadsTable)->insert([
                            'discussion_id'    => (int) $post->discussion_id,
                            'post_id'          => (int) $post->id,
                            'parent_post_id'   => $parentId,
                            'root_post_id'     => (int) $threadData['root_post_id'],
                            'depth'            => (int) $threadData['depth'],
                            'thread_path'      => (string) $threadData['thread_path'],
                            'child_count'      => 0,
                            'descendant_count' => 0,
                            'created_at'       => $post->created_at,
                            'updated_at'       => $post->created_at,
                        ]);

                        $processedCount++;
                    } catch (\Throwable $e) {
                        $errorCount++;
                        resolve('log')->warning('[Threadify] rebuild-parent-ids insert error for post '.$post->id.': '.$e->getMessage());
                    }
                }
            });

        $results['threads_processed'] = $processedCount;
        $results['threads_errors'] = $errorCount;

        $prefix = $db->getTablePrefix();
        $threadsPhysical = $prefix . $threadsTable;
        resolve('log')->info('[Threadify] RebuildParentIdsController: Updating child and descendant counts in '.$threadsPhysical.' table');
        // PART 3: Update child and descendant counts (raw SQL needs prefixed table name)
        $db->statement("
            UPDATE {$threadsPhysical} t1
            INNER JOIN (
                SELECT parent_post_id, COUNT(*) as count
                FROM {$threadsPhysical}
                WHERE parent_post_id IS NOT NULL
                GROUP BY parent_post_id
            ) t2 ON t1.post_id = t2.parent_post_id
            SET t1.child_count = t2.count
        ");

        $db->statement("
            UPDATE {$threadsPhysical} t1
            INNER JOIN (
                SELECT root_post_id, COUNT(*) - 1 as count
                FROM {$threadsPhysical}
                GROUP BY root_post_id
            ) t2 ON t1.post_id = t2.root_post_id
            SET t1.descendant_count = t2.count
            WHERE t1.parent_post_id IS NULL
        ");

        // Non-root descendant counts (Query Builder -> use logical table name, NOT prefixed)
        $db->table($threadsTable)
            ->select(['id', 'thread_path'])
            ->whereNotNull('parent_post_id')
            ->orderBy('id')
            ->chunkById(500, function ($threads) use ($db, $threadsTable) {
                foreach ($threads as $thread) {
                    $descendantCount = $db->table($threadsTable)
                        ->where('thread_path', 'LIKE', $thread->thread_path . '/%')
                        ->count();

                    $db->table($threadsTable)
                        ->where('id', $thread->id)
                        ->update(['descendant_count' => $descendantCount]);
                }
            });


        $results['child_descendant_counts_updated'] = true;

        return new JsonResponse(['status' => 'ok', 'results' => $results]);
    }

    private static function extractParentFromContent($content): ?int
    {
        if (!$content) return null;

        if (preg_match('/<POSTMENTION[^>]+id=\"(\d+)\"[^>]*>/', $content, $m)) {
            return (int) $m[1];
        }
        if (preg_match('/<[^>]+class=\"[^\"]*PostMention[^\"]*\"[^>]+data-id=\"(\d+)\"[^>]*>/', $content, $m)) {
            return (int) $m[1];
        }
        if (preg_match('/@\"[^\"]*\"#p(\d+)/', $content, $m)) {
            return (int) $m[1];
        }
        return null;
    }

    private static function calculateThreadData(ConnectionInterface $db, string $postsTable, ?int $parentId, int $postId): array
    {
        if (!$parentId) {
            return [
                'root_post_id' => $postId,
                'depth' => 0,
                'thread_path' => (string) $postId,
            ];
        }

        $parentPost = $db->table($postsTable)->select(['id', 'parent_id'])->where('id', $parentId)->first();

        if (!$parentPost) {
            return [
                'root_post_id' => $postId,
                'depth' => 0,
                'thread_path' => (string) $postId,
            ];
        }

        if (!$parentPost->parent_id) {
            return [
                'root_post_id' => $parentId,
                'depth' => 1,
                'thread_path' => $parentId . '/' . $postId,
            ];
        }

        $rootPostId = self::findRootPostId($db, $postsTable, $parentId);
        $depth = self::calculateDepth($db, $postsTable, $parentId) + 1;
        $threadPath = self::buildThreadPath($db, $postsTable, $parentId) . '/' . $postId;

        return [
            'root_post_id' => $rootPostId,
            'depth' => $depth,
            'thread_path' => $threadPath,
        ];
    }

    private static function findRootPostId(ConnectionInterface $db, string $postsTable, int $postId): int
    {
        $current = $postId;
        while (true) {
            $post = $db->table($postsTable)->select(['id', 'parent_id'])->where('id', $current)->first();
            if (!$post || !$post->parent_id) return $current;
            $current = (int) $post->parent_id;
        }
    }

    private static function calculateDepth(ConnectionInterface $db, string $postsTable, int $postId): int
    {
        $depth = 0;
        $current = $postId;
        while (true) {
            $post = $db->table($postsTable)->select(['id', 'parent_id'])->where('id', $current)->first();
            if (!$post || !$post->parent_id) break;
            $depth++;
            $current = (int) $post->parent_id;
        }
        return $depth;
    }

    private static function buildThreadPath(ConnectionInterface $db, string $postsTable, int $postId): string
    {
        $path = [];
        $current = $postId;
        while (true) {
            $post = $db->table($postsTable)->select(['id', 'parent_id'])->where('id', $current)->first();
            if (!$post) break;
            array_unshift($path, (string) $current);
            if (!$post->parent_id) break;
            $current = (int) $post->parent_id;
        }
        return implode('/', $path);
    }
}
