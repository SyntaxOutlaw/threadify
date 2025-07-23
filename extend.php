<?php

use Flarum\Extend;
use Flarum\Post\Event\Saving;
use Flarum\Api\Serializer\PostSerializer;
use SyntaxOutlaw\Threadify\Listener\SavePostParentId;

return [
    // Frontend assets
    (new Extend\Frontend('forum'))
        ->js(__DIR__ . '/js/dist/forum.js')
        ->css(__DIR__ . '/resources/less/forum.less'),
    
    (new Extend\Frontend('admin'))
        ->js(__DIR__ . '/js/dist/admin.js'),
    
    // Event listeners
    (new Extend\Event())
        ->listen(Saving::class, SavePostParentId::class),
    
    // API serialization  
    (new Extend\ApiSerializer(PostSerializer::class))
        ->attributes(function ($serializer, $post, $request) {
            $attributes = [];
            
            // Add parent_id to the API response
            if (isset($post->parent_id)) {
                $attributes['parent_id'] = $post->parent_id;
            }
            
            return $attributes;
        }),
];
