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

        return new JsonResponse([
            'threadifyTag' => $settings->get('syntaxoutlaw-threadify.tag', 'threadify'),
            'tagsExtensionEnabled' => $tagsEnabled,
        ]);
    }
}
