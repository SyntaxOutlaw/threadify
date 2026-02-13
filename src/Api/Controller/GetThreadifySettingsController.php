<?php

namespace SyntaxOutlaw\Threadify\Api\Controller;

use Flarum\Extension\ExtensionManager;
use Flarum\Http\RequestUtil;
use Flarum\Settings\SettingsRepositoryInterface;
use Laminas\Diactoros\Response\JsonResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;

class GetThreadifySettingsController implements RequestHandlerInterface
{
    public function handle(ServerRequestInterface $request): ResponseInterface
    {
        $actor = RequestUtil::getActor($request);
        $actor->assertAdmin();

        /** @var SettingsRepositoryInterface $settings */
        $settings = resolve(SettingsRepositoryInterface::class);
        /** @var ExtensionManager $extensions */
        $extensions = resolve(ExtensionManager::class);

        $tagsEnabled = $extensions->isEnabled('flarum-tags');

        // Support multiple tags: syntaxoutlaw-threadify.tags (JSON array) or fallback to single syntaxoutlaw-threadify.tag
        $tagsJson = $settings->get('syntaxoutlaw-threadify.tags');
        if ($tagsJson !== null && $tagsJson !== '') {
            $tagsList = json_decode($tagsJson, true);
            $threadifyTags = is_array($tagsList) ? $tagsList : ['threadify'];
        } else {
            $single = $settings->get('syntaxoutlaw-threadify.tag', 'threadify');
            $threadifyTags = $single ? [$single] : ['threadify'];
        }

        return new JsonResponse([
            'threadifyTag' => $threadifyTags[0] ?? 'threadify', // backward compat for admin that expects single
            'threadifyTags' => $threadifyTags,
            'tagsExtensionEnabled' => $tagsEnabled,
        ]);
    }
}
