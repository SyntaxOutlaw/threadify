<?php

use Flarum\Extend;
use Flarum\Post\Event\Saving;
use Flarum\Post\Event\Posted;
use Flarum\Api\Serializer\PostSerializer;

use SyntaxOutlaw\Threadify\Listener\SavePostParentId;
use SyntaxOutlaw\Threadify\Listener\SavePostToThreadifyTable;
use SyntaxOutlaw\Threadify\Api\Controller\ListDiscussionThreadsController;
use SyntaxOutlaw\Threadify\Api\Controller\ListDiscussionThreadsOrderController; // ← 新增导入

return [
    // Frontend assets
    (new Extend\Frontend('forum'))
        ->js(__DIR__ . '/js/dist/forum.js')
        ->css(__DIR__ . '/resources/less/forum.less'),

    (new Extend\Frontend('admin'))
        ->js(__DIR__ . '/js/dist/admin.js'),

    // API Routes
    (new Extend\Routes('api'))
        // 旧的富数据端点（含 included）
        ->get('/discussions/{id}/threads', 'discussions.threads', ListDiscussionThreadsController::class)
        // 新增：轻量顺序预取端点（仅顺序/深度/父子关系）
        ->get('/discussions/{id}/threads-order', 'threadify.threadsOrder', ListDiscussionThreadsOrderController::class)
        // 管理端：重建 parent_id + 线程表
        ->post('/threadify/admin/rebuild-parent-ids', 'threadify.admin.rebuild-parent-ids', SyntaxOutlaw\Threadify\Api\Controller\RebuildParentIdsController::class),

    // Event listeners
    (new Extend\Event())
        ->listen(Saving::class, SavePostParentId::class)
        ->listen(Posted::class, SavePostToThreadifyTable::class),

    // API serialization（兼容：把 parent_id 暴露到 Post API）
    (new Extend\ApiSerializer(PostSerializer::class))
        ->attributes(function ($serializer, $post, $request) {
            $attributes = [];
            if (isset($post->parent_id)) {
                $attributes['parent_id'] = $post->parent_id;
            }
            return $attributes;
        }),
];

