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

        // Get discussion ID from route parameters
        $routeParams = $request->getAttribute('routeParameters', []);
        $discussionId = intval($routeParams['id'] ?? 0);
        
        if (!$discussionId) {
            throw new \InvalidArgumentException('Discussion ID is required');
        }
        
        $discussion = Discussion::findOrFail($discussionId);
        $threads = ThreadifyThread::getDiscussionThreads($discussionId);
        
        return $threads;
    }
} 