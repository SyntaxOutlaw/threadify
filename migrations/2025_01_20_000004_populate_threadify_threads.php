<?php

use Illuminate\Database\Schema\Builder;
use Illuminate\Database\Schema\Blueprint;

if (!function_exists('threadify_calc_thread_data')) {
    function threadify_calc_thread_data($db, $post, $tableName) {
        $parentId = $post->parent_id;

        if (!$parentId) {
            return [
                'root_post_id' => (int) $post->id,
                'depth'        => 0,
                'thread_path'  => (string) $post->id,
            ];
        }

        $parentThread = $db->table($tableName)->where('post_id', $parentId)->first();

        if (!$parentThread) {
            // 父尚未写入（按创建时间遍历一般会先于子写入，但这里防御）
            return [
                'root_post_id' => (int) $post->id,
                'depth'        => 0,
                'thread_path'  => (string) $post->id,
            ];
        }

        return [
            'root_post_id' => (int) $parentThread->root_post_id,
            'depth'        => (int) $parentThread->depth + 1,
            'thread_path'  => (string) ($parentThread->thread_path . '/' . $post->id),
        ];
    }
}

return [
    'up' => function (Builder $schema) {
        $db = $schema->getConnection();

        if (! $schema->hasTable('threadify_threads')) return;
        if (! $schema->hasColumn('posts', 'parent_id')) return;

        $table = 'threadify_threads';

        // 清空旧数据（如果有）
        $db->table($table)->truncate();

        // 依讨论 & 时间升序遍历，尽可能保证父先于子
        $posts = $db->table('posts')
            ->where('type', 'comment')
            ->orderBy('discussion_id', 'asc')
            ->orderBy('created_at', 'asc')
            ->select(['id','discussion_id','parent_id','created_at'])
            ->get();

        foreach ($posts as $p) {
            // 避免重复
            $exists = $db->table($table)->where('post_id', $p->id)->exists();
            if ($exists) continue;

            $td = threadify_calc_thread_data($db, $p, $table);

            $db->table($table)->insert([
                'discussion_id'   => (int) $p->discussion_id,
                'post_id'         => (int) $p->id,
                'parent_post_id'  => $p->parent_id ? (int) $p->parent_id : null,
                'root_post_id'    => (int) $td['root_post_id'],
                'depth'           => (int) $td['depth'],
                'thread_path'     => (string) $td['thread_path'],
                'child_count'     => 0,
                'descendant_count'=> 0,
                'created_at'      => $p->created_at,
                'updated_at'      => $p->created_at,
            ]);
        }

        // —— 事后统计：child_count
        $childCounts = $db->table($table)
            ->selectRaw('parent_post_id, COUNT(*) as cnt')
            ->whereNotNull('parent_post_id')
            ->groupBy('parent_post_id')
            ->get();

        foreach ($childCounts as $row) {
            $db->table($table)
                ->where('post_id', $row->parent_post_id)
                ->update(['child_count' => (int) $row->cnt]);
        }

        // —— 事后统计：descendant_count
        // 根帖：整棵树规模 - 1
        $rootCounts = $db->table($table)
            ->selectRaw('root_post_id, COUNT(*) - 1 as cnt')
            ->groupBy('root_post_id')
            ->get();

        foreach ($rootCounts as $row) {
            $db->table($table)
                ->where('post_id', $row->root_post_id)
                ->whereNull('parent_post_id')
                ->update(['descendant_count' => max(0, (int) $row->cnt)]);
        }

        // 非根：按路径前缀统计（无索引也可接受；若数据量极大，后续可改队列分批或用 path_hash）
        $threads = $db->table($table)
            ->whereNotNull('parent_post_id')
            ->select(['id','thread_path'])
            ->get();

        foreach ($threads as $th) {
            $cnt = $db->table($table)
                ->where('thread_path', 'LIKE', $th->thread_path.'/%')
                ->count();

            $db->table($table)->where('id', $th->id)->update(['descendant_count' => (int) $cnt]);
        }
    },

    'down' => function (Builder $schema) {
        if (! $schema->hasTable('threadify_threads')) return;
        $schema->getConnection()->table('threadify_threads')->truncate();
    },
];
