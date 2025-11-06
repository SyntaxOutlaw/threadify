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

        // 逻辑表名（供 Query Builder 使用，自动加前缀）
        $tableLogical  = 'threadify_threads';
        // 物理表名（仅供 raw SQL 使用，需要手动带前缀）
        $tablePrefixed = $db->getTablePrefix() . $tableLogical;

        $results = [
            'parent_id_updated'  => 0,
            'parent_id_skipped'  => 0,
            'threads_processed'  => 0,
            'threads_errors'     => 0,
            'child_descendant_counts_updated' => false,
        ];

        // --- PART 1: 从内容回填 posts.parent_id ---
        $posts = $db->table('posts')
            ->whereNull('parent_id')
            ->where('type', 'comment')
            ->select(['id', 'discussion_id', 'content'])
            ->get();

        foreach ($posts as $post) {
            $parentId = self::extractParentFromContent($post->content);
            if (!$parentId) {
                $results['parent_id_skipped']++;
                continue;
            }

            $parentExists = $db->table('posts')
                ->where('id', $parentId)
                ->where('discussion_id', $post->discussion_id)
                ->exists();

            if ($parentExists) {
                $db->table('posts')->where('id', $post->id)->update(['parent_id' => $parentId]);
                $results['parent_id_updated']++;
            } else {
                $results['parent_id_skipped']++;
            }
        }

        // --- PART 2: 重建 threadify_threads ---
        // 清空旧数据
        $db->table($tableLogical)->truncate();

        // 以讨论 & 时间升序遍历，尽量保证父先子后
        $all = $db->table('posts')
            ->where('type', 'comment')
            ->orderBy('discussion_id')
            ->orderBy('created_at')
            ->get();

        foreach ($all as $post) {
            try {
                $parentId   = $post->parent_id;
                $threadData = self::calculateThreadData($db, $post, $parentId, $tableLogical);

                $db->table($tableLogical)->insert([
                    'discussion_id'   => $post->discussion_id,
                    'post_id'         => $post->id,
                    'parent_post_id'  => $parentId,
                    'root_post_id'    => $threadData['root_post_id'],
                    'depth'           => $threadData['depth'],
                    'thread_path'     => $threadData['thread_path'],
                    'child_count'     => 0,
                    'descendant_count'=> 0,
                    'created_at'      => $post->created_at,
                    'updated_at'      => $post->created_at,
                ]);

                $results['threads_processed']++;
            } catch (\Throwable $e) {
                $results['threads_errors']++;
            }
        }

        // --- PART 3: 统计 child_count / descendant_count ---
        // 3.1 子数（使用 raw SQL，但带上前缀的物理表名）
        $db->statement("
            UPDATE {$tablePrefixed} t1
            INNER JOIN (
                SELECT parent_post_id, COUNT(*) AS cnt
                FROM {$tablePrefixed}
                WHERE parent_post_id IS NOT NULL
                GROUP BY parent_post_id
            ) t2 ON t1.post_id = t2.parent_post_id
            SET t1.child_count = t2.cnt
        ");

        // 3.2 根节点后代数（同上）
        $db->statement("
            UPDATE {$tablePrefixed} t1
            INNER JOIN (
                SELECT root_post_id, COUNT(*) - 1 AS cnt
                FROM {$tablePrefixed}
                GROUP BY root_post_id
            ) t2 ON t1.post_id = t2.root_post_id
            SET t1.descendant_count = t2.cnt
            WHERE t1.parent_post_id IS NULL
        ");

        // 3.3 非根节点后代数：用 Query Builder（自动前缀）
        $threads = $db->table($tableLogical)->whereNotNull('parent_post_id')->get(['id', 'thread_path']);
        foreach ($threads as $thread) {
            $descendantCount = $db->table($tableLogical)
                ->where('thread_path', 'LIKE', $thread->thread_path . '/%')
                ->count();

            $db->table($tableLogical)
                ->where('id', $thread->id)
                ->update(['descendant_count' => $descendantCount]);
        }

        $results['child_descendant_counts_updated'] = true;

        return new JsonResponse(['status' => 'ok', 'results' => $results]);
    }

    /* -------------------- Helpers -------------------- */

    private static function extractParentFromContent($content): ?int
    {
        if (!$content) return null;

        // <POSTMENTION ... id="123" ...>
        if (preg_match('/<POSTMENTION[^>]+id=\"(\d+)\"[^>]*>/', $content, $m)) {
            return (int) $m[1];
        }
        // class="...PostMention..." data-id="123"
        if (preg_match('/<[^>]+class=\"[^\"]*PostMention[^\"]*\"[^>]+data-id=\"(\d+)\"[^>]*>/', $content, $m)) {
            return (int) $m[1];
        }
        // @"Display Name"#p123
        if (preg_match('/@\"[^\"]*\"#p(\d+)/', $content, $m)) {
            return (int) $m[1];
        }

        return null;
        }

    private static function calculateThreadData(ConnectionInterface $db, $post, ?int $parentId, string $tableLogical): array
    {
        if (!$parentId) {
            return [
                'root_post_id' => (int) $post->id,
                'depth'        => 0,
                'thread_path'  => (string) $post->id,
            ];
        }

        $parentThread = $db->table($tableLogical)
            ->where('post_id', $parentId)
            ->first();

        if (!$parentThread) {
            // 父记录尚未入表：作为根处理（后续统计不受影响）
            return [
                'root_post_id' => (int) $post->id,
                'depth'        => 0,
                'thread_path'  => (string) $post->id,
            ];
        }

        return [
            'root_post_id' => (int) $parentThread->root_post_id,
            'depth'        => (int) $parentThread->depth + 1,
            'thread_path'  => (string) ($parentThread->thread_path . '/' . $post->id),
        ];
    }
}
