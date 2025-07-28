<?php

namespace SyntaxOutlaw\Threadify\Api\Controller;

use Flarum\Api\Controller\AbstractListController;
use Flarum\Discussion\Discussion;
use Flarum\Http\RequestUtil;
use Flarum\User\Exception\PermissionDeniedException;
use Psr\Http\Message\ServerRequestInterface;
use Illuminate\Support\Arr;
use SyntaxOutlaw\Threadify\Api\Serializer\ThreadifyThreadSerializer;
use SyntaxOutlaw\Threadify\Model\ThreadifyThread;
use Tobscure\JsonApi\Document;

class ListDiscussionThreadsController extends AbstractListController
{
    /**
     * The serializer to use for the response
     */
    public $serializer = ThreadifyThreadSerializer::class;
    
    /**
     * Include relationships with the thread data
     */
    public $include = ['post', 'post.user'];
    
    /**
     * Get the data to be serialized and assigned to the response document
     */
    protected function data(ServerRequestInterface $request, Document $document)
    {
        $actor = RequestUtil::getActor($request);
        $discussionId = intval(Arr::get($request->getQueryParams(), 'id'));
        
        // Find the discussion and check view permissions
        $discussion = Discussion::findOrFail($discussionId);
        
        // Check if the actor can view this discussion
        if (!$actor->can('view', $discussion)) {
            throw new PermissionDeniedException();
        }
        
        // Get all threads for this discussion in proper order
        $threads = ThreadifyThread::getDiscussionThreads($discussionId);
        
        // Filter out posts the user can't see
        $visibleThreads = $threads->filter(function ($thread) use ($actor) {
            return $thread->post && $actor->can('view', $thread->post);
        });
        
        return $visibleThreads;
    }
} 