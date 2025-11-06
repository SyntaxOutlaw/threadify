<?php

use Illuminate\Database\Schema\Builder;

if (!function_exists('threadify_extract_parent_from_content')) {
    function threadify_extract_parent_from_content($content) {
        if (!$content) return null;
        // <POSTMENTION ... id="123" ...>
        if (preg_match('/<POSTMENTION[^>]+id="(\d+)"[^>]*>/', $content, $m)) {
            return (int) $m[1];
        }
        // class="...PostMention..." data-id="123"
        if (preg_match('/<[^>]+class="[^"]*PostMention[^"]*"[^>]+data-id="(\d+)"[^>]*>/', $content, $m)) {
            return (int) $m[1];
        }
        // @"Display Name"#p123
        if (preg_match('/@"[^"]*"#p(\d+)/', $content, $m)) {
            return (int) $m[1];
        }
        return null;
    }
}

return [
    'up' => function (Builder $schema) {
        if (! $schema->hasColumn('posts', 'parent_id')) return;

        $db = $schema->getConnection();
        $posts = $db->table('posts')
            ->whereNull('parent_id')
            ->where('type', 'comment')
            ->select(['id','discussion_id','content'])
            ->get();

        foreach ($posts as $p) {
            $pid = threadify_extract_parent_from_content($p->content);
            if (!$pid) continue;

            $exists = $db->table('posts')
                ->where('id', $pid)
                ->where('discussion_id', $p->discussion_id)
                ->exists();

            if ($exists) {
                $db->table('posts')->where('id', $p->id)->update(['parent_id' => $pid]);
            }
        }
    },

    'down' => function (Builder $schema) {
        if (! $schema->hasColumn('posts', 'parent_id')) return;
        $schema->getConnection()->table('posts')->update(['parent_id' => null]);
    },
];
