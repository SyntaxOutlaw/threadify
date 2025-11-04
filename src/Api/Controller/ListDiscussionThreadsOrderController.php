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
        $actor = RequestUtil::getActor($request);
        $route = $request->getAttribute('routeParameters', []);
        $discussionId = (int) ($route['id'] ?? 0);

        // 1) 讨论存在 & 鉴权
        $discussion = Discussion::findOrFail($discussionId);
        if (! $actor->can('view', $discussion)) {
            throw new PermissionDeniedException();
        }

        /** @var ConnectionInterface $db */
        $db = resolve(ConnectionInterface::class);

        try {
            // 2) 线程表缺失时优雅返回
            if (! $db->getSchemaBuilder()->hasTable('threadify_threads')) {
                return new JsonResponse([
                    'discussionId' => $discussionId,
                    'order' => [],
                    'count' => 0,
                    'note'  => 'threadify_threads table missing',
                ]);
            }

            // 3) 读取本讨论的线程行 + posts.created_at（不选 posts.updated_at）
            $rows = $db->table('threadify_threads')
                ->join('posts', 'posts.id', '=', 'threadify_threads.post_id')
                ->where('threadify_threads.discussion_id', $discussionId)
                ->select([
                    'threadify_threads.post_id',
                    'threadify_threads.parent_post_id',
                    'threadify_threads.depth',
                    // 两个时间都取出：优先用线程表的 created_at，缺失再用 posts.created_at
                    'threadify_threads.created_at as t_created_at',
                    'posts.created_at as p_created_at',
                ])
                // 先按线程表的 created_at 升序，缺失情况下排序仍然稳定
                ->orderBy('threadify_threads.created_at', 'asc')
                ->get();

            // 4) 邻接表（父->子）
            $byParent = [];
            foreach ($rows as $r) {
                $pid = $r->parent_post_id ?: 0;
                $byParent[$pid][] = $r;
            }

            // 统一的“安全时间戳”取值函数（避免 strcmp null deprecated）
            $ts = static function ($row): int {
                // t_created_at 优先，其次 p_created_at，最后 0
                if (!empty($row->t_created_at)) {
                    return (int) strtotime((string) $row->t_created_at) ?: 0;
                }
                if (!empty($row->p_created_at)) {
                    return (int) strtotime((string) $row->p_created_at) ?: 0;
                }
                return 0;
            };

            $sortByTime = static function (&$arr) use ($ts) {
                usort($arr, function ($a, $b) use ($ts) {
                    $ta = $ts($a);
                    $tb = $ts($b);
                    if ($ta === $tb) return 0;
                    return ($ta < $tb) ? -1 : 1;
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

            return new JsonResponse([
                'discussionId' => $discussionId,
                'order'        => $order,
                'count'        => count($order),
            ]);
        } catch (\Throwable $e) {
            resolve('log')->error('[Threadify] threads-order error: '.$e->getMessage(), [
                'trace' => $e->getTraceAsString(),
            ]);

            return new JsonResponse([
                'error'   => 'threads-order failed',
                'message' => $e->getMessage(),
            ], 500);
        }
    }
}

