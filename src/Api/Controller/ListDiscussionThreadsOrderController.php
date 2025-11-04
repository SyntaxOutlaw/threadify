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

        // 讨论是否存在
        $discussion = Discussion::findOrFail($discussionId);

        // ✅ 正确的鉴权：对 actor 校验能否 view 该 discussion
        if (! $actor->can('view', $discussion)) {
            throw new PermissionDeniedException();
        }

        /** @var ConnectionInterface $db */
        $db = resolve(ConnectionInterface::class);

        try {
            // 表缺失时优雅返回，避免 500
            if (! $db->getSchemaBuilder()->hasTable('threadify_threads')) {
                return new JsonResponse([
                    'discussionId' => $discussionId,
                    'order' => [],
                    'count' => 0,
                    'note'  => 'threadify_threads table missing',
                ]);
            }

            // 取出该讨论的线程节点
            $rows = $db->table('threadify_threads')
                ->where('discussion_id', $discussionId)
                ->select(['post_id','parent_post_id','depth','created_at'])
                ->orderBy('created_at', 'asc')
                ->get();

            // 按父子关系构建邻接表
            $byParent = [];
            foreach ($rows as $r) {
                $pid = $r->parent_post_id ?: 0;
                $byParent[$pid][] = $r;
            }
            $sortByTime = static function (&$arr) {
                usort($arr, fn($a, $b) => strcmp($a->created_at, $b->created_at));
            };

            // DFS 扁平化：父后跟子，兄弟按时间
            $order = [];
            $dfs = function($node) use (&$dfs, &$byParent, &$order, $sortByTime) {
                $order[] = [
                    'postId'       => (int) $node->post_id,
                    'order'        => 0, // 占位，稍后写下标
                    'depth'        => (int) $node->depth,
                    'parentPostId' => $node->parent_post_id ? (int)$node->parent_post_id : null,
                ];
                $children = $byParent[$node->post_id] ?? [];
                if ($children) {
                    $sortByTime($children);
                    foreach ($children as $ch) $dfs($ch);
                }
            };

            $roots = $byParent[0] ?? [];
            $sortByTime($roots);
            foreach ($roots as $root) $dfs($root);

            foreach ($order as $i => &$o) $o['order'] = $i;

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
