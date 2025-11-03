<?php

namespace SyntaxOutlaw\Threadify\Services;

use Illuminate\Database\ConnectionInterface as DB;

class ThreadOrderService
{
    public function __construct(protected DB $db) {}

    /**
     * 返回扁平化顺序（父后跟子，兄弟按 created_at 升序）
     * @return array<int, array{post_id:int, parent_post_id:?int, depth:int}>
     */
    public function flattenedOrder(int $discussionId): array
    {
        $rows = $this->db->table('threadify_threads')
            ->where('discussion_id', $discussionId)
            ->select(['post_id', 'parent_post_id', 'depth', 'created_at'])
            ->orderBy('created_at', 'asc') // 只是便于初始分组；最终顺序我们在 PHP 里 DFS
            ->get();

        // 建邻接表
        $byParent = [];
        $meta     = [];
        foreach ($rows as $r) {
            $pid = $r->parent_post_id ?: 0;
            $byParent[$pid][] = $r;
            $meta[$r->post_id] = $r;
        }

        // 根（parent_post_id 为空）
        $roots = $byParent[0] ?? [];
        usort($roots, fn($a, $b) => strcmp($a->created_at, $b->created_at));

        $out = [];
        $dfs = function($node) use (&$dfs, &$byParent, &$out) {
            $out[] = [
                'post_id'        => (int) $node->post_id,
                'parent_post_id' => $node->parent_post_id ? (int)$node->parent_post_id : null,
                'depth'          => (int) $node->depth,
            ];
            $children = $byParent[$node->post_id] ?? [];
            if ($children) {
                usort($children, fn($a, $b) => strcmp($a->created_at, $b->created_at));
                foreach ($children as $ch) $dfs($ch);
            }
        };

        foreach ($roots as $root) $dfs($root);

        return $out;
    }
}
