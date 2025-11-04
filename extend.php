<?php

use Flarum\Extend;
use Flarum\Post\Event\Saving;
use Flarum\Post\Event\Posted;
use Flarum\Api\Serializer\PostSerializer;

use SyntaxOutlaw\Threadify\Listener\SavePostParentId;
use SyntaxOutlaw\Threadify\Listener\SavePostToThreadifyTable;

use SyntaxOutlaw\Threadify\Api\Controller\ListDiscussionThreadsController;
use SyntaxOutlaw\Threadify\Api\Controller\RebuildParentIdsController;
use SyntaxOutlaw\Threadify\Api\Controller\ListDiscussionThreadsOrderController;

return [
    // Forum 前端资源
    (new Extend\Frontend('forum'))
        ->js(__DIR__ . '/js/dist/forum.js')
        ->css(__DIR__ . '/resources/less/forum.less'),

    // Admin 前端资源（可选）
    (new Extend\Frontend('admin'))
        ->js(__DIR__ . '/js/dist/admin.js'),

    // API 路由
    (new Extend\Routes('api'))
        ->get('/discussions/{id}/threads', 'threadify.threads', ListDiscussionThreadsController::class)
        ->get('/discussions/{id}/threads-order', 'threadify.threadsOrder', ListDiscussionThreadsOrderController::class)
        ->post('/threadify/admin/rebuild-parent-ids', 'threadify.admin.rebuild-parent-ids', RebuildParentIdsController::class),

    // 事件监听
    (new Extend\Event())
        ->listen(Saving::class, SavePostParentId::class)
        ->listen(Posted::class, SavePostToThreadifyTable::class),

    // API 输出追加字段（兼容 parent_id）
    (new Extend\ApiSerializer(PostSerializer::class))
        ->attributes(function ($serializer, $post, $request) {
            return [
                'parent_id' => $post->parent_id ?? null,
            ];
        }),
];

