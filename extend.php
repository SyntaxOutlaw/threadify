<?php

namespace SyntaxOutlaw\Threadify\Api\Controller;

use Flarum\Discussion\Discussion;
use Flarum\Http\RequestUtil;
use Flarum\User\Exception\PermissionDeniedException;
use Illuminate\Database\ConnectionInterface;
use Laminas\Diactoros\Response\JsonResponse;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;

class ListDiscussionThreadsOrderController implements RequestHandlerInterface
{
    public function handle(ServerRequestInterface $request): JsonResponse
    {
        // 防止任何 notice/echo 污染 JSON
        ob_start();

        $actor = RequestUtil::getActor($request);
        $route = $request->getAttribute('routeParameters', []);
        $discussionId = (int) ($route['id'] ?? 0);

        $discussion = Discussion::findOrFail($discussionId);

        // 正确鉴权：对 actor 校验能否查看 discussion
        if (! $actor->can('view', $discussion)) {
            ob_end_clean();
            throw new PermissionDeniedException();
        }

        /** @var ConnectionInterface $db */
        $db = resolve(ConnectionInterface::class);

        try {
            // 表缺失：直接返回空数据，避免 500
            if (! $db->getSchemaBuilder()->hasTable('threadify_threads')) {
                ob_end_clean();
                return new JsonResponse([
                    'discussionId' => $discussionId,
                    'order' => [],
                    'count' => 0,
                    'note'  => 'threadify_threads table missing',
                ], 200, ['Cache-Control' => 'no-store']);
            }

            // 取出该讨论的线程节点；用 posts.created_at 兜底，避免 NULL
            $rows = $db->table('threadify_threads as t')
                ->leftJoin('posts as p', 'p.id', '=', 't.post_id')
                ->where('t.discussion_id', $discussionId)
                ->select([
                    't.post_id',
                    't.parent_post_id',
                    't.depth',
                    $db->raw('COALESCE(t.created_at, p.created_at) as sort_at'),
                ])
                ->orderBy('sort_at', 'asc') // 粗排序：顶层按时间
                ->get();

            // 建邻接表
            $byParent = [];
            foreach ($rows as $r) {
                $pid = $r->parent_post_id ?: 0;
                $byParent[$pid][] = $r;
            }

            // 安全时间戳转换（NULL/无效字符串返回 0）
            $toTs = static function ($v): int {
                if ($v instanceof \DateTimeInterface) return $v->getTimestamp();
                if (is_string($v)) {
                    $ts = strtotime($v);
                    return $ts ? (int)$ts : 0;
                }
                if (is_numeric($v)) return (int)$v;
                return 0;
            };

            // 兄弟节点排序：先按时间戳，再按 post_id 稳定
            $sortSiblings = static function (&$arr) use ($toTs) {
                usort($arr, static function ($a, $b) use ($toTs) {
                    $ta = $toTs($a->sort_at ?? null);
                    $tb = $toTs($b->sort_at ?? null);
                    if ($ta === $tb) return ((int)$a->post_id) <=> ((int)$b->post_id);
                    return $ta <=> $tb;
                });
            };

            // DFS 扁平化：父后跟子
            $order = [];
            $dfs = function ($node) use (&$dfs, &$byParent, &$order, $sortSiblings) {
                $order[] = [
                    'postId'       => (int)$node->post_id,
                    'order'        => 0, // 占位
                    'depth'        => (int)$node->depth,
                    'parentPostId' => $node->parent_post_id ? (int)$node->parent_post_id : null,
                ];
                $children = $byParent[$node->post_id] ?? [];
                if ($children) {
                    $sortSiblings($children);
                    foreach ($children as $ch) $dfs($ch);
                }
            };

            $roots = $byParent[0] ?? [];
            $sortSiblings($roots);
            foreach ($roots as $root) $dfs($root);

            // 写线性下标
            foreach ($order as $i => &$o) $o['order'] = $i;

            // 丢弃任何杂输出
            $garbage = ob_get_clean();
            if ($garbage) {
                resolve('log')->warning('[Threadify] threads-order stray output suppressed', ['garbage' => $garbage]);
            }

            return new JsonResponse([
                'discussionId' => $discussionId,
                'order'        => $order,
                'count'        => count($order),
            ], 200, ['Cache-Control' => 'no-store']);
        } catch (\Throwable $e) {
            $garbage = ob_get_clean();
            resolve('log')->error('[Threadify] threads-order error: '.$e->getMessage(), [
                'trace'   => $e->getTraceAsString(),
                'garbage' => $garbage,
            ]);
            return new JsonResponse([
                'error'   => 'threads-order failed',
                'message' => $e->getMessage(),
            ], 500);
        }
    }
}
