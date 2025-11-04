<?php

namespace SyntaxOutlaw\Threadify\Services;

use Illuminate\Database\ConnectionInterface as DB;

class ThreadOrderService
{
    public function __construct(protected DB $db) {}

    /**
     * 返回给定讨论的扁平化顺序（仅限传入的可见帖子集合）
     * 父后跟子，兄弟按 created_at 升序；时间相等按 post_id 稳定排序
     *
     * @param int   $discussionId
     * @param int[] $visiblePostIds
     * @return array<int, array{post_id:int,parent_post_id:?int,depth:int}>
     */
    public function flattenedOrderVisible(int $discussionId, array $visiblePostIds): array
    {
        if (empty($visiblePostIds)) return [];

        $rows = $this->db->table('threadify_threads')
            ->join('posts', 'posts.id', '=', 'threadify_threads.post_id')
            ->where('threadify_threads.discussion_id', $discussionId)
            ->whereIn('threadify_threads.post_id', $visiblePostIds)
            ->select([
                'threadify_threads.post_id',
                'threadify_threads.parent_post_id',
                'threadify_threads.depth',
                'threadify_threads.created_at as t_created_at',
                'threadify_threads.updated_at as t_updated_at',
                'posts.created_at as p_created_at',
                'posts.updated_at as p_updated_at',
            ])
            ->orderBy('threadify_threads.created_at', 'asc')
            ->get();

        foreach ($rows as $r) {
            $r->_created_at = $r->t_created_at ?? $r->p_created_at ?? null;
        }

        $byParent = [];
        foreach ($rows as $r) {
            $pid = $r->parent_post_id ?: 0;
            $byParent[$pid][] = $r;
        }

        $sortByTime = static function (&$arr) {
            usort($arr, static function ($a, $b) {
                $ta = $a->_created_at ?? '';
                $tb = $b->_created_at ?? '';
                if ($ta === $tb) return ($a->post_id <=> $b->post_id);
                return $ta <=> $tb;
            });
        };

        $out = [];
        $dfs = function ($node) use (&$dfs, &$byParent, &$out, $sortByTime) {
            $out[] = [
                'post_id'        => (int) $node->post_id,
                'parent_post_id' => $node->parent_post_id ? (int) $node->parent_post_id : null,
                'depth'          => (int) $node->depth,
            ];
            $children = $byParent[$node->post_id] ?? [];
            if ($children) {
                $sortByTime($children);
                foreach ($children as $ch) $dfs($ch);
            }
        };

        $roots = $byParent[0] ?? [];
        if ($roots) {
            $sortByTime($roots);
            foreach ($roots as $root) $dfs($root);
        }

        return $out;
    }
}
