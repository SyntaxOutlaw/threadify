<?php

use Flarum\Extend;
use Flarum\Post\Event\Saving;
use Flarum\Post\Event\Posted;
use Flarum\Api\Serializer\PostSerializer;
use Flarum\Api\Serializer\ForumSerializer;
use Flarum\Settings\SettingsRepositoryInterface;
use SyntaxOutlaw\Threadify\Listener\SavePostParentId;
use SyntaxOutlaw\Threadify\Listener\SavePostToThreadifyTable;
use SyntaxOutlaw\Threadify\Api\Controller\ListDiscussionThreadsController;


return [
    // Frontend assets
    (new Extend\Frontend('forum'))
        ->js(__DIR__ . '/js/dist/forum.js')
        ->css(__DIR__ . '/resources/less/forum.less'),
    
    (new Extend\Frontend('admin'))
        ->js(__DIR__ . '/js/dist/admin.js'),
    
    // API Routes
    (new Extend\Routes('api'))
        ->get('/discussions/{id}/threads', 'discussions.threads', ListDiscussionThreadsController::class)
        ->post('/threadify/admin/rebuild-parent-ids', 'threadify.admin.rebuild-parent-ids', SyntaxOutlaw\Threadify\Api\Controller\RebuildParentIdsController::class),
    
    // Event listeners
    (new Extend\Event())
        ->listen(Saving::class, SavePostParentId::class)
        ->listen(Posted::class, SavePostToThreadifyTable::class),

    // Expose extension settings to the forum frontend via ForumSerializer
    (new Extend\ApiSerializer(ForumSerializer::class))
        ->attributes(function ($serializer, $forum, $request) {
            $settings = resolve(SettingsRepositoryInterface::class);
            $mode = $settings->get('syntaxoutlaw-threadify.mode', 'default');
            
            return [
                'threadifyMode' => $mode ?: 'default', // Ensure it's never null
            ];
        }),

    // API serialization  
    (new Extend\ApiSerializer(PostSerializer::class))
        ->attributes(function ($serializer, $post, $request) {
            $attributes = [];
            
            // Add parent_id to the API response (still needed for backward compatibility)
            if (isset($post->parent_id)) {
                $attributes['parent_id'] = $post->parent_id;
            }
            
            return $attributes;
        }),
];
