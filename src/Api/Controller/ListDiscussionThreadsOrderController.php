<?php

namespace SyntaxOutlaw\Threadify\Api\Controller;

use Flarum\Discussion\Discussion;
use Flarum\Http\RequestUtil;
use Illuminate\Database\ConnectionInterface;
use Laminas\Diactoros\Response\JsonResponse;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;

class ListDiscussionThreadsOrderController implements RequestHandlerInterface
{
    public function handle(ServerRequestInterface $request): JsonResponse
    {
        $actor        = RequestUtil::getActor($request);
        $route        = $request->getAttribute('routeParameters', []);
        $discussionId = (int) ($route['id'] ?? 0);

        // 1) 可见性校验：使用 whereVisibleTo($actor) 与核心保持一致（修复普通用户 403）
        $discussion = Discussion::query()
            ->whereVisibleTo($actor)
            ->findOrFail($discussionId);

        /** @var ConnectionInterface $db */
        $db = resolve(ConnectionInterface::class);

        try {
            // 2) 线程表缺失时优雅返回（避免 500）
            if (! $db->getSchemaBuilder()->hasTable('threadify_threads')) {
                return new JsonResponse([
                    'discussionId' => $discussionId,
                    'order'        => [],
                    'count'        => 0,
                    'note'         => 'threadify_threads table missing',
                ]);
            }

            // 3) 读取本讨论的线程行 + posts.created_at（不选 posts.updated_at，规避部分环境无列问题）
            $rows = $db->table('threadify_threads as t')
                ->join('posts as p', 'p.id', '=', 't.post_id')
                ->where('t.discussion_id', $discussionId)
                ->select([
                    't.post_id',
                    't.parent_post_id',
                    't.depth',
                    // 两个时间都取出：优先用线程表的 created_at，缺失再用 posts.created_at
                    't.created_at as t_created_at',
                    'p.created_at as p_created_at',
                ])
                // 先按 t.created_at 升序，后续在 PHP 中对同父兄弟再做稳定时间排序
                ->orderBy('t.created_at', 'asc')
                ->get();

            // 4) 邻接表（父 -> 子）
            $byParent = [];

            // 统一的“安全时间戳”取值函数（避免 strcmp null deprecated）
            $ts = static function ($row): int {
                // t_created_at 优先，其次 p_created_at，最后 0
                if (! empty($row->t_created_at)) {
                    return (int) strtotime((string) $row->t_created_at) ?: 0;
                }
                if (! empty($row->p_created_at)) {
                    return (int) strtotime((string) $row->p_created_at) ?: 0;
                }
                return 0;
            };

            // [!! OPTIMIZED !!] 优化：预先计算时间戳，避免在 usort 中高频调用
            foreach ($rows as $r) {
                $pid          = $r->parent_post_id ?: 0;
                $r->safe_ts   = $ts($r); // 在此处一次性计算
                $byParent[$pid][] = $r;
            }

            // [!! OPTIMIZED !!] 优化：usort 直接比较预先计算好的整数
            $sortByTime = static function (&$arr) {
                usort($arr, function ($a, $b) {
                    if ($a->safe_ts === $b->safe_ts) {
                        return 0;
                    }
                    return ($a->safe_ts < $b->safe_ts) ? -1 : 1;
                });
            };

            // 5) DFS 扁平化：父后跟子，兄弟按时间
            $order = [];

            $dfs = function ($node) use (&$dfs, &$byParent, &$order, $sortByTime) {
                $order[] = [
                    'postId'       => (int) $node->post_id,
                    'order'        => 0, // 稍后写入序号
                    'depth'        => (int) $node->depth,
                    'parentPostId' => $node->parent_post_id ? (int) $node->parent_post_id : null,
                ];

                $children = $byParent[$node->post_id] ?? [];
                if ($children) {
                    $sortByTime($children);
                    foreach ($children as $ch) {
                        $dfs($ch);
                    }
                }
            };

            $roots = $byParent[0] ?? [];
            $sortByTime($roots);
            foreach ($roots as $root) {
                $dfs($root);
            }

            // 写入序号
            foreach ($order as $i => &$o) {
                $o['order'] = $i;
            }
            unset($o);

            return new JsonResponse([
                'discussionId' => $discussionId,
                'order'        => $order,
                'count'        => count($order),
            ]);
        } catch (\Throwable $e) {
            resolve('log')->error('[Threadify] threads-order error: ' . $e->getMessage(), [
                'trace' => $e->getTraceAsString(),
            ]);

            return new JsonResponse([
                'error'   => 'threads-order failed',
                'message' => $e->getMessage(),
            ], 500);
        }
    }
}
