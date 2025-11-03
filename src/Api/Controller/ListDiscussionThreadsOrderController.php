<?php

namespace SyntaxOutlaw\Threadify\Api\Controller;

use Flarum\Discussion\Discussion;
use Flarum\Http\RequestUtil;
use Laminas\Diactoros\Response\JsonResponse;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;
use SyntaxOutlaw\Threadify\Services\ThreadOrderService;

class ListDiscussionThreadsOrderController implements RequestHandlerInterface
{
    public function __construct(protected ThreadOrderService $order) {}

    public function handle(ServerRequestInterface $request): JsonResponse
    {
        $actor = RequestUtil::getActor($request);

        $route = $request->getAttribute('routeParameters', []);
        $discussionId = (int) ($route['id'] ?? 0);
        $discussion = Discussion::findOrFail($discussionId);

        // 基础权限：能看帖子即可
        $discussion->assertCan($actor, 'view');

        $flat = $this->order->flattenedOrder($discussionId);
        // 仅传最轻量的数据
        $order = [];
        foreach ($flat as $i => $row) {
            $order[] = [
                'postId'       => $row['post_id'],
                'order'        => $i,
                'depth'        => $row['depth'],
                'parentPostId' => $row['parent_post_id'],
            ];
        }

        return new JsonResponse([
            'discussionId' => $discussionId,
            'order'        => $order,
            'count'        => count($order),
        ]);
    }
}
