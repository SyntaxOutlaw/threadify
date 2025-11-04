<?php

namespace SyntaxOutlaw\Threadify\Api\Controller;

use Flarum\Discussion\Discussion;
use Flarum\Http\RequestUtil;
use Flarum\User\Exception\PermissionDeniedException;
use Flarum\Post\Post;
use Illuminate\Database\ConnectionInterface;
use Laminas\Diactoros\Response\JsonResponse;
use Laminas\Diactoros\Response\EmptyResponse;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;

class ListDiscussionThreadsOrderController implements RequestHandlerInterface
{
    public function handle(ServerRequestInterface $request): \Psr\Http\Message\ResponseInterface
    {
        $actor = RequestUtil::getActor($request);
        $route = $request->getAttribute('routeParameters', []);
        $discussionId = (int) ($route['id'] ?? 0);

        /** @var Discussion $discussion */
        $discussion = Discussion::findOrFail($discussionId);

        // 鉴权：能否查看该讨论
        if (! $actor->can('view', $discussion)) {
            throw new PermissionDeniedException();
        }

        /** @var ConnectionInterface $db */
        $db = resolve(ConnectionInterface::class);

        try {
            // 表缺失时优雅返回
            if (! $db->getSchemaBuilder()->hasTable('threadify_threads')) {
                $payload = [
                    'discussionId' => $discussionId,
                    'order'        => [],
                    'count'        => 0,
                    'note'         => 'threadify_threads table missing',
                ];
                return new JsonResponse($payload, 200, [
                    'Cache-Control' => 'private, max-age=30',
                ]);
            }

            // 取 actor 可见的帖子 id 集合（保证顺序映射与前端可见集一致）
            $visibleIds = Post::query()
                ->where('discussion_id', $discussionId)
                ->whereVisibleTo($actor)
                ->pluck('id')
                ->all();

            if (empty($visibleIds)) {
                // 讨论存在但当前用户看不到任何帖子
                $payload = [
                    'discussionId' => $discussionId,
                    'order'        => [],
                    'count'        => 0,
                ];
                return new JsonResponse($payload, 200, [
                    'Cache-Control' => 'private, max-age=30',
                ]);
            }

            // 读取 threadify_threads（连 posts 以回退 created_at），只保留可见帖子
            $rows = $db->table('threadify_threads as t')
                ->join('posts as p', 'p.id', '=', 't.post_id')
                ->where('t.discussion_id', $discussionId)
                ->whereIn('t.post_id', $visibleIds)
                ->selectRaw('t.post_id, t.parent_post_id, t.depth, COALESCE(t.created_at, p.created_at) AS created_at, COALESCE(t.updated_at, t.created_at, p.updated_at, p.created_at) AS updated_at')
                // 预排序仅为构邻接表提供更稳定的初始序；真正顺序由 DFS 决定
                ->orderBy('created_at', 'asc')
                ->get();

            // 计算 Last-Modified / ETag（基于最大更新时间）
            $lastUpdatedAt = null;
            foreach ($rows as $r) {
                $ts = $r->updated_at ?? null;
                if ($ts !== null && ($lastUpdatedAt === null || $ts > $lastUpdatedAt)) {
                    $lastUpdatedAt = $ts;
                }
            }
            // 如果计算不到，就用讨论更新时间兜底
            if ($lastUpdatedAt === null && $discussion->updated_at) {
                $lastUpdatedAt = $discussion->updated_at->toDateTimeString();
            }
            $lastMod = $lastUpdatedAt ? gmdate('D, d M Y H:i:s', strtotime($lastUpdatedAt)) . ' GMT' : null;
            $etag    = $lastUpdatedAt ? sprintf('W/"tdo-%d-%s"', $discussionId, sha1($lastUpdatedAt)) : null;

            // 条件请求：If-None-Match / If-Modified-Since
            $ifNoneMatch     = $request->getHeaderLine('If-None-Match') ?: null;
            $ifModifiedSince = $request->getHeaderLine('If-Modified-Since') ?: null;

            if ($etag && $ifNoneMatch && trim($ifNoneMatch) === $etag) {
                return new EmptyResponse(304, [
                    'ETag'          => $etag,
                    'Last-Modified' => $lastMod ?? '',
                    'Cache-Control' => 'private, max-age=60',
                ]);
            }
            if ($lastMod && $ifModifiedSince && (strtotime($ifModifiedSince) >= strtotime($lastMod))) {
                return new EmptyResponse(304, [
                    'ETag'          => $etag ?? '',
                    'Last-Modified' => $lastMod,
                    'Cache-Control' => 'private, max-age=60',
                ]);
            }

            // ---- 构建邻接表并 DFS 扁平化（父后跟子，兄弟按时间升序；时间相等时按 post_id 稳定排序） ----
            $byParent = [];
            foreach ($rows as $r) {
                $pid = $r->parent_post_id ?: 0;
                $byParent[$pid][] = $r;
            }

            $sortByTime = static function (&$arr) {
                usort($arr, static function ($a, $b) {
                    $ta = $a->created_at ?? '';
                    $tb = $b->created_at ?? '';
                    if ($ta === $tb) {
                        // 稳定性保障：时间相同按 post_id
                        return ($a->post_id <=> $b->post_id);
                    }
                    // DATETIME 字符串字典序可比较时间先后
                    return $ta <=> $tb;
                });
            };

            $order = [];
            $dfs = function ($node) use (&$dfs, &$byParent, &$order, $sortByTime) {
                $order[] = [
                    'postId'       => (int) $node->post_id,
                    'order'        => 0,  // 占位，稍后写入索引
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
            if ($roots) {
                $sortByTime($roots);
                foreach ($roots as $root) {
                    $dfs($root);
                }
            }

            foreach ($order as $i => &$o) {
                $o['order'] = $i;
            }

            $payload = [
                'discussionId' => $discussionId,
                'order'        => $order,
                'count'        => count($order),
            ];

            $headers = ['Cache-Control' => 'private, max-age=60'];
            if ($etag)   $headers['ETag'] = $etag;
            if ($lastMod) $headers['Last-Modified'] = $lastMod;

            return new JsonResponse($payload, 200, $headers);
        } catch (\Throwable $e) {
            // 记录错误但不把 PHP 警告/notice 混入 JSON
            try {
                resolve('log')->error('[Threadify] threads-order error: '.$e->getMessage(), [
                    'trace' => $e->getTraceAsString(),
                ]);
            } catch (\Throwable $e2) {
                // ignore logger failures
            }

            return new JsonResponse([
                'error'   => 'threads-order failed',
                'message' => 'Internal error',
            ], 500, ['Cache-Control' => 'no-store']);
        }
    }
}

