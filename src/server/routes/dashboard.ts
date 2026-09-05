// src/server/routes/dashboard.ts — `GET /api/dashboard`(設計 §10-1 エンドポイント表 / §10-4)。
//
// 責務(薄いルート):
//   - `readUsage(projectRoot)` → `?from` / `?to`(ISO date)で ts 範囲フィルタ
//   - `aggregateUsage(records)` で集計(§10-4 `UsageStats`)
//   - `skippedLogLines` に `readUsage().skipped` を代入(§10-4 / §13-13)
//   - `notesByCategory` は現在の `knowledge/` 実走査(`listNotes`)を主とする(§10-4)
//   - 加えて `noteCount` / `categoryCount`(タスク指示。§10-4 `UsageStats` には未定義の加算フィールド)
//
// ルート結線は別タスク。`api.route('/dashboard', createDashboardRoutes(deps))`。

import { Hono } from 'hono';
import { listNotes } from '../../core/note.js';
import { aggregateUsage, readUsage, type UsageStats } from '../../core/usage-log.js';

/** `createDashboardRoutes` の依存。 */
export interface DashboardRoutesDeps {
  /** projectRoot 絶対パス。 */
  projectRoot: string;
}

/** §10-4 `UsageStats` + タスク指示の総数(加算フィールド)。 */
interface DashboardResponse extends UsageStats {
  /** 現在の `knowledge/` の総ノート数(`listNotes` 実測)。 */
  noteCount: number;
  /** `categories[0]` の異なり数(`_uncategorized` 含む)。 */
  categoryCount: number;
}

const UNCATEGORIZED = '_uncategorized';

export function createDashboardRoutes(deps: DashboardRoutesDeps): Hono {
  const r = new Hono();

  r.get('/', async (c) => {
    const from = c.req.query('from');
    const to = c.req.query('to');

    const { records, skipped } = await readUsage(deps.projectRoot);
    const filtered = records.filter((rec) => {
      const ts = typeof rec.ts === 'string' ? rec.ts : '';
      if (from !== undefined && from !== '' && ts < from) return false;
      if (to !== undefined && to !== '' && ts.slice(0, 10) > to) return false;
      return true;
    });

    const stats = await aggregateUsage(filtered);
    stats.skippedLogLines = skipped;

    // §10-4: notesByCategory は現在の knowledge/ 実測を主とする(削除・移動を反映するため)。
    const { notes } = await listNotes(deps.projectRoot);
    const byCategory = new Map<string, number>();
    for (const note of notes) {
      const first = Array.isArray(note.fm.categories) ? note.fm.categories[0] : undefined;
      const key = typeof first === 'string' && first !== '' ? first : UNCATEGORIZED;
      byCategory.set(key, (byCategory.get(key) ?? 0) + 1);
    }
    stats.notesByCategory = [...byCategory.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count || (a.category < b.category ? -1 : 1));

    const payload: DashboardResponse = {
      ...stats,
      noteCount: notes.length,
      categoryCount: byCategory.size,
    };
    return c.json(payload);
  });

  return r;
}

export default createDashboardRoutes;
