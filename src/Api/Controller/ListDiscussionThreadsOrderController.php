<?php

namespace SyntaxOutlaw\Threadify\Api\Controller;

use Flarum\Discussion\Discussion;
use Flarum\Http\RequestUtil;
use Flarum\Post\Post;
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

        // 1) 讨论可见性校验（与核心一致）
        $discussion = Discussion::query()
            ->whereVisibleTo($actor)
            ->findOrFail($discussionId);

        /** @var ConnectionInterface $db */
        $db = resolve(ConnectionInterface::class);

        // 可选：只有显式开启时才把事件帖编入序列，默认关，保证与旧前端100%兼容
        $qp = $request->getQueryParams();
        $withEvents = isset($qp['with_events']) && (string)$qp['with_events'] !== '0';

        // 2) 线程表缺失时优雅返回
        if (! $db->getSchemaBuilder()->hasTable('threadify_threads')) {
            return new JsonResponse([
                'discussionId' => $discussionId,
                'order'        => [],
                'count'        => 0,
                'note'         => 'threadify_threads table missing',
            ]);
        }

        // 3) 读取本讨论的“评论贴”线程行 + posts.created_at
        $rows = $db->table('threadify_threads as t')
            ->join('posts as p', 'p.id', '=', 't.post_id')
            ->where('t.discussion_id', $discussionId)
            ->select([
                't.post_id',
                't.parent_post_id',
                't.depth',
                't.created_at as t_created_at',
                'p.created_at as p_created_at',
            ])
            ->orderBy('t.created_at', 'asc')
            ->get();

        // 安全时间戳
        $ts = static function ($row): int {
            if (!empty($row->t_created_at)) return (int) strtotime((string) $row->t_created_at) ?: 0;
            if (!empty($row->p_created_at)) return (int) strtotime((string) $row->p_created_at) ?: 0;
            return 0;
        };

        // 4) DFS 扁平化评论（父后跟子，兄弟按时间）
        $byParent = [];
        foreach ($rows as $r) {
            $pid = $r->parent_post_id ?: 0;
            $byParent[$pid][] = $r;
        }
        $sortByTime = static function (&$arr) use ($ts) {
            usort($arr, function ($a, $b) use ($ts) {
                $ta = $ts($a); $tb = $ts($b);
                if ($ta === $tb) return ($a->post_id <=> $b->post_id);
                return $ta <=> $tb;
            });
        };

        $order = [];            // 输出条目
        $commentTimeline = [];  // 用于事件帖锚定：每条含 post_id, order, ts

        $dfs = function ($node) use (&$dfs, &$byParent, &$order, &$commentTimeline, $sortByTime, $ts) {
            $entry = [
                'postId'       => (int) $node->post_id,
                'order'        => 0, // 先占位
                'depth'        => (int) $node->depth,
                'parentPostId' => $node->parent_post_id ? (int) $node->parent_post_id : null,
                'type'         => 'comment',
            ];
            $order[] = $entry;

            $children = $byParent[$node->post_id] ?? [];
            if ($children) {
                $sortByTime($children);
                foreach ($children as $ch) $dfs($ch);
            }
        };

        $roots = $byParent[0] ?? [];
        $sortByTime($roots);
        foreach ($roots as $root) $dfs($root);

        // 写入顺序号（整数）
        foreach ($order as $i => &$o) {
            $o['order'] = $i;
            $commentTimeline[] = [
                'post_id' => $o['postId'],
                'order'   => $i,
                'ts'      => 0, // 先置0，稍后填时间
            ];
        }
        unset($o);

        // 回填评论时间轴
        $tsByPost = [];
        foreach ($rows as $r) $tsByPost[(int)$r->post_id] = $ts($r);
        foreach ($commentTimeline as &$ct) $ct['ts'] = $tsByPost[$ct['post_id']] ?? 0;
        unset($ct);

        // 5) （可选）把事件帖也编进序列（仅 with_events=1 时）
        if ($withEvents) {
            // 只取当前讨论、对 actor 可见的非 comment 帖子
            $events = Post::query()
                ->where('discussion_id', $discussionId)
                ->where('type', '!=', 'comment')
                ->whereVisibleTo($actor)
                ->orderBy('created_at', 'asc')
                ->get(['id', 'type', 'created_at']);

            if ($events->count()) {
                // 为快速锚定，按时间升序的评论列表
                usort($commentTimeline, fn($a, $b) => ($a['ts'] <=> $b['ts']) ?: ($a['order'] <=> $b['order']));

                foreach ($events as $ev) {
                    $ets = (int) strtotime((string) $ev->created_at) ?: 0;

                    // 找“时间上不晚于它”的最近评论作为锚（双指针/二分都可，这里线性即可，量小）
                    $anchorOrder = null;
                    $anchorPostId = null;
                    for ($i = count($commentTimeline) - 1; $i >= 0; $i--) {
                        if ($commentTimeline[$i]['ts'] <= $ets) {
                            $anchorOrder  = $commentTimeline[$i]['order'];
                            $anchorPostId = $commentTimeline[$i]['post_id'];
                            break;
                        }
                    }
                    if ($anchorOrder === null) {
                        // 没有更早评论：放到最前（比第0条更小一点）
                        $anchorOrder  = -1;
                        $anchorPostId = null;
                    }

                    // 事件帖顺序号：锚点之后的一个浮点位置（不影响整数评论序）
                    $order[] = [
                        'postId'       => (int) $ev->id,
                        'order'        => $anchorOrder + 0.5,
                        'depth'        => 0,
                        'parentPostId' => null,
                        'type'         => 'event',
                        // 如需调试可返回：'anchorPostId' => $anchorPostId,
                    ];
                }

                // 合并后整体按 order 升序、postId 兜底
                usort($order, function ($a, $b) {
                    if ($a['order'] == $b['order']) return $a['postId'] <=> $b['postId'];
                    return ($a['order'] < $b['order']) ? -1 : 1;
                });

                // 也可以（可选）重编号评论的整数序，但没必要；前端按浮点比较即可
            }
        }

        return new JsonResponse([
            'discussionId' => $discussionId,
            'order'        => $order,
            'count'        => count($order),
        ]);
    }
}
