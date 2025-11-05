<?php

use Flarum\Extend;
use Flarum\Post\Event\Saving;
use Flarum\Post\Event\Posted;

use SyntaxOutlaw\Threadify\Listener\SavePostParentId;
use SyntaxOutlaw\Threadify\Listener\SavePostToThreadifyTable;

use SyntaxOutlaw\Threadify\Api\Controller\ListDiscussionThreadsOrderController;
use SyntaxOutlaw\Threadify\Api\Controller\RebuildParentIdsController;

return [
    // Forum 前端资源
    (new Extend\Frontend('forum'))
        ->js(__DIR__ . '/js/dist/forum.js')
        ->css(__DIR__ . '/resources/less/forum.less'),

    // Admin 前端资源（提供“重建 parent id”入口的单页）
    (new Extend\Frontend('admin'))
        ->js(__DIR__ . '/js/dist/admin.js'),

    // API 路由（仅保留前端实际使用的 threads-order 与管理用 rebuild-parent-ids）
    (new Extend\Routes('api'))
        ->get('/discussions/{id}/threads-order', 'threadify.threadsOrder', ListDiscussionThreadsOrderController::class)
        ->post('/threadify/admin/rebuild-parent-ids', 'threadify.admin.rebuild-parent-ids', RebuildParentIdsController::class),

    // 事件监听：保存 parent_id；新帖入 threadify_threads
    (new Extend\Event())
        ->listen(Saving::class, SavePostParentId::class)
        ->listen(Posted::class, SavePostToThreadifyTable::class),
];

