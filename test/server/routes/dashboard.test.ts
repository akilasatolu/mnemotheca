// test/server/routes/dashboard.test.ts — 設計 §10-1 / §10-4 / §13-13。

import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Frontmatter } from '../../../src/core/frontmatter.js';
import { noteAbsPathForCategory, writeNote } from '../../../src/core/note.js';
import { mnemothecaPaths } from '../../../src/core/paths.js';
import { appendUsage } from '../../../src/core/usage-log.js';
import { createApp } from '../../../src/server/app.js';
import { createDashboardRoutes } from '../../../src/server/routes/dashboard.js';
import { makeProject } from '../../helpers/project.js';

const TOKEN = 'test-dash-token';
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const d = roots.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

async function mkProject(): Promise<string> {
  const root = await makeProject();
  roots.push(root);
  return root;
}

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `20260901T093015${String(idCounter).padStart(3, '0')}cd`;
}

async function addNote(root: string, cat: string, slug: string): Promise<void> {
  const abs = noteAbsPathForCategory(root, cat, slug);
  const fm: Frontmatter = {
    id: nextId(),
    title: `T-${slug}`,
    categories: [cat],
    tags: ['x'],
    created: '2026-09-01T09:30:15+09:00',
    updated: '2026-09-01T09:30:15+09:00',
    summary: 's',
    source: 'claude-desktop',
  };
  await writeNote(abs, fm, '## 詳細\n\n本文\n');
}

function mountApp(root: string) {
  const api = new Hono();
  api.route('/dashboard', createDashboardRoutes({ projectRoot: root }));
  return createApp(
    { projectRoot: root, token: TOKEN, port: 4712, startedAt: new Date().toISOString() },
    api,
  );
}

const auth = { Authorization: `Bearer ${TOKEN}` };

interface DashboardBody {
  range: { from: string; to: string };
  totals: { store: number; organize: number; show: number; notesCreated: number; notesDeleted: number };
  storeCountByDay: { date: string; count: number }[];
  notesByCategory: { category: string; count: number }[];
  modeCountByMonth: { month: string; store: number; organize: number; show: number }[];
  lastUsedAt: { store: string | null; organize: string | null; show: string | null };
  skippedLogLines: number;
  noteCount: number;
  categoryCount: number;
}

describe('GET /api/dashboard — 空ログ(§13-6 / §13-13)', () => {
  it('usage_log 無し → ゼロ集計・エラーなし・構造は完全', async () => {
    const root = await mkProject();
    const res = await mountApp(root).request('/api/dashboard', { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as DashboardBody;

    expect(body.totals).toEqual({ store: 0, organize: 0, show: 0, notesCreated: 0, notesDeleted: 0 });
    expect(body.storeCountByDay).toEqual([]);
    expect(body.notesByCategory).toEqual([]);
    expect(body.modeCountByMonth).toEqual([]);
    expect(body.lastUsedAt).toEqual({ store: null, organize: null, show: null });
    expect(body.skippedLogLines).toBe(0);
    expect(body.noteCount).toBe(0);
    expect(body.categoryCount).toBe(0);
  });
});

describe('GET /api/dashboard — 複数レコード(§10-4 / §13-13)', () => {
  it('モード別回数・日別集計・skippedLogLines・notesByCategory(実測)', async () => {
    const root = await mkProject();

    await appendUsage(root, {
      ts: '2026-09-01T10:00:00+09:00',
      mode: 'store',
      event: 'store.apply',
      ok: true,
      count: 2,
      categories: ['ml'],
    });
    await appendUsage(root, {
      ts: '2026-09-02T11:00:00+09:00',
      mode: 'store',
      event: 'store.apply',
      ok: true,
      count: 1,
      categories: ['architecture'],
    });
    await appendUsage(root, {
      ts: '2026-09-02T12:00:00+09:00',
      mode: 'show',
      event: 'show.open',
      ok: true,
    });

    // 壊れ行を 1 行足す → skippedLogLines に反映される
    fs.appendFileSync(mnemothecaPaths(root).usageLogJsonl, 'not-json-line\n');

    // 現在の knowledge/ 実測(notesByCategory / noteCount / categoryCount 用)
    await addNote(root, 'ml', 'a');
    await addNote(root, 'ml', 'b');
    await addNote(root, 'architecture', 'c');

    const res = await mountApp(root).request('/api/dashboard', { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as DashboardBody;

    expect(body.totals.store).toBe(2);
    expect(body.totals.show).toBe(1);
    expect(body.totals.notesCreated).toBe(3); // count 2 + 1
    expect(body.storeCountByDay).toEqual([
      { date: '2026-09-01', count: 2 },
      { date: '2026-09-02', count: 1 },
    ]);
    expect(body.modeCountByMonth).toEqual([
      { month: '2026-09', store: 2, organize: 0, show: 1 },
    ]);
    expect(body.lastUsedAt.store).toBe('2026-09-02T11:00:00+09:00');
    expect(body.skippedLogLines).toBe(1);

    // notesByCategory はログ由来ではなく listNotes 実測(件数降順)
    expect(body.notesByCategory).toEqual([
      { category: 'ml', count: 2 },
      { category: 'architecture', count: 1 },
    ]);
    expect(body.noteCount).toBe(3);
    expect(body.categoryCount).toBe(2);
  });

  it('?from / ?to で ts 範囲を絞る', async () => {
    const root = await mkProject();
    await appendUsage(root, { ts: '2026-08-20T10:00:00+09:00', mode: 'store', event: 'store.apply', ok: true, count: 1 });
    await appendUsage(root, { ts: '2026-09-02T10:00:00+09:00', mode: 'store', event: 'store.apply', ok: true, count: 1 });
    await appendUsage(root, { ts: '2026-09-10T10:00:00+09:00', mode: 'store', event: 'store.apply', ok: true, count: 1 });

    const res = await mountApp(root).request('/api/dashboard?from=2026-09-01&to=2026-09-05', { headers: auth });
    const body = (await res.json()) as DashboardBody;
    expect(body.totals.store).toBe(1);
    expect(body.storeCountByDay).toEqual([{ date: '2026-09-02', count: 1 }]);
  });

  it('トークン無し → 401', async () => {
    const root = await mkProject();
    const res = await mountApp(root).request('/api/dashboard');
    expect(res.status).toBe(401);
  });
});
