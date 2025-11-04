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
                $payload = [
                    'discussionId' => $discussionId,
                    'order'        => [],
                    'count'        => 0,
                ];
                return new JsonResponse($payload, 200, [
                    'Cache-Control' => 'private, max-age=30',
                ]);
            }

            // 不使用别名，避免表前缀影响；把需要的时间列分别取回，COALESCE 在 PHP 侧做
            $rows = $db->table('threadify_threads')
                ->join('posts', 'posts.id', '=', 'threadify_threads.post_id')
                ->where('threadify_threads.discussion_id', $discussionId)
                ->whereIn('threadify_threads.post_id', $visibleIds)
                ->select([
                    'threadify_threads.post_id',
                    'threadify_threads.parent_post_id',
                    'threadify_threads.depth',
                    'threadify_threads.created_at as t_created_at',
                    'threadify_threads.updated_at as t_updated_at',
                    'posts.created_at as p_created_at',
                    'posts.updated_at as p_updated_at',
                ])
                // 预排序仅用于初步稳定，真正顺序由 DFS 确定
                ->orderBy('threadify_threads.created_at', 'asc')
                ->get();

            // 计算合并后的 created/updated，并求 Last-Modified / ETag
            $lastUpdatedAt = null;
            foreach ($rows as $r) {
                // COALESCE(created_at)
                $r->_created_at = $r->t_created_at ?? $r->p_created_at ?? null;
                // COALESCE(updated_at, created_at)
                $r->_updated_at = $r->t_updated_at
                    ?? $r->t_created_at
                    ?? $r->p_updated_at
                    ?? $r->p_created_at
                    ?? null;

                if ($r->_updated_at !== null && ($lastUpdatedAt === null || $r->_updated_at > $lastUpdatedAt)) {
                    $lastUpdatedAt = $r->_updated_at;
                }
            }
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

            // ---- 构邻接表 & DFS 扁平化（父后跟子，兄弟按时间升序；时间相等按 post_id 稳定）----
            $byParent = [];
            foreach ($rows as $r) {
                $pid = $r->parent_post_id ?: 0;
                $byParent[$pid][] = $r;
            }

            $sortByTime = static function (&$arr) {
                usort($arr, static function ($a, $b) {
                    $ta = $a->_created_at ?? '';
                    $tb = $b->_created_at ?? '';
                    if ($ta === $tb) {
                        return ($a->post_id <=> $b->post_id);
                    }
                    return $ta <=> $tb; // DATETIME 字符串可直接字典序比较
                });
            };

            $order = [];
            $dfs = function ($node) use (&$dfs, &$byParent, &$order, $sortByTime) {
                $order[] = [
                    'postId'       => (int) $node->post_id,
                    'order'        => 0,
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
            try {
                resolve('log')->error('[Threadify] threads-order error: '.$e->getMessage(), [
                    'trace' => $e->getTraceAsString(),
                ]);
            } catch (\Throwable $e2) {
                // ignore
            }

            return new JsonResponse([
                'error'   => 'threads-order failed',
                'message' => 'Internal error',
            ], 500, ['Cache-Control' => 'no-store']);
        }
    }
}

