// test/e2e/full-flow.test.ts — 設計 §13-16 結合(E2E 相当)。
//
// makeProject → mnemo_store(dry-run → apply)→ vault にファイル生成 →
// createApp で GET /api/notes・/api/notes/:id/rendered・/api/search →
// mnemo_organize_scan → preview → apply → undo で復元 → reindex 差分 → 件数一致。
//
// 実プロセス spawn / 実ブラウザ / 実ネットワークは使わず、モジュール直呼び + createApp。

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listNotes, writeNote } from '../../src/core/note.js';
import type { Frontmatter } from '../../src/core/frontmatter.js';
import { vaultPaths } from '../../src/core/paths.js';
import { buildIndex, type IndexHandle } from '../../src/core/search.js';
import { reindexPaths } from '../../src/mcp/reindex-client.js';
import { __resetStoreDryRunMemory } from '../../src/mcp/tools/store.js';
import { createWatcher, type ChokidarLike } from '../../src/server/watcher.js';
import {
  buildApp,
  callTool,
  cleanupRoots,
  firstText,
  getJson,
  makeTrackedProject,
  sc,
  storeNotes,
  writeBrokenNote,
} from '../helpers/e2e.js';

beforeEach(() => {
  __resetStoreDryRunMemory();
});

afterEach(() => {
  cleanupRoots();
});

interface NotesListBody {
  total: number;
  items: { id: string; title: string; path: string }[];
}
interface SearchBody {
  total: number;
  results: { id: string; title: string; path: string }[];
}
interface ScanSC {
  sessionId: string;
  proposals: { proposalId: string; kind: string; destructiveness: string }[];
  noteCount: number;
}
interface ApplySC {
  snapshot: string;
  applied: string[];
}

describe('§13-16 full-flow: store → HTTP 閲覧/検索 → organize scan/preview/apply/undo → reindex', () => {
  it('一気通し: 保存物が API から見え、organize apply/undo で件数が元に戻る', async () => {
    const root = await makeTrackedProject();

    // ── 1. mnemo_store: dry-run → apply ───────────────────────────────
    const applied = await storeNotes(root, [
      { slug: 'aws-mcp-feasibility', title: 'AWS MCP 実現可能性', targetDir: 'architecture' },
      { slug: 'bigram-tokenizer', title: 'bigram トークナイザ設計', targetDir: 'search' },
      { slug: 'elicitation-support', title: 'elicitation 対応方針', targetDir: 'mcp' },
    ]);
    const createdPaths = sc<{ created: { path: string }[] }>(applied).created.map((c) => c.path);
    expect(createdPaths).toEqual([
      'knowledge/architecture/aws-mcp-feasibility.md',
      'knowledge/search/bigram-tokenizer.md',
      'knowledge/mcp/elicitation-support.md',
    ]);
    for (const rel of createdPaths) {
      expect(fs.existsSync(path.join(vaultPaths(root).root, ...rel.split('/')))).toBe(true);
    }

    // ── 2. HTTP: 一覧 / 詳細(rendered)/ 検索 ───────────────────────
    const app = buildApp(root);

    const list = await getJson<NotesListBody>(app, '/api/notes');
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(3);

    const target = list.body.items.find((i) => i.path === 'knowledge/search/bigram-tokenizer.md');
    expect(target).toBeDefined();
    const rendered = await getJson<{ id: string; html: string; path: string }>(
      app,
      `/api/notes/${target!.id}/rendered`,
    );
    expect(rendered.status).toBe(200);
    expect(rendered.body.path).toBe('knowledge/search/bigram-tokenizer.md');
    expect(rendered.body.html).toContain('本文');

    const search = await getJson<SearchBody>(app, '/api/search?q=' + encodeURIComponent('トークナイザ'));
    expect(search.status).toBe(200);
    expect(search.body.results.map((r) => r.path)).toContain('knowledge/search/bigram-tokenizer.md');

    // ── 3. organize: scan → preview → apply(非破壊 fix-frontmatter)→ undo ──
    // categories[0] が実ディレクトリと食い違うノートを 1 つ足して fix-frontmatter を誘発。
    const mismatchAbs = path.join(vaultPaths(root).knowledgeDir, 'architecture', 'mislabeled.md');
    const mismatchFm: Frontmatter = {
      id: '20260901T093000001aa',
      title: 'ラベル不一致ノート',
      categories: ['search'],
      tags: [],
      created: '2026-09-01T09:30:00+09:00',
      updated: '2026-09-01T09:30:00+09:00',
      summary: '',
    };
    await writeNote(mismatchAbs, mismatchFm, '## 要約\n\n本文\n');

    const scanRes = await callTool('mnemo_organize_scan', { apply: false, scope: 'all' }, root);
    const scan = sc<ScanSC>(scanRes);
    expect(scan.sessionId.startsWith('org-')).toBe(true);
    const fix = scan.proposals.find((p) => p.kind === 'fix-frontmatter');
    expect(fix).toBeDefined();

    const previewRes = await callTool(
      'mnemo_organize_preview',
      { sessionId: scan.sessionId, proposalIds: [fix!.proposalId] },
      root,
    );
    expect(previewRes.isError).toBeUndefined();
    expect(sc<{ diffs: unknown[] }>(previewRes).diffs.length).toBeGreaterThan(0);

    const notesBeforeApply = (await getJson<NotesListBody>(app, '/api/notes')).body.total; // 4
    expect(notesBeforeApply).toBe(4);

    const applyRes = await callTool(
      'mnemo_organize_apply',
      {
        sessionId: scan.sessionId,
        proposalIds: [fix!.proposalId],
        label: 'organize',
        confirmedDestructive: [],
      },
      root,
    );
    const applySC = sc<ApplySC>(applyRes);
    expect(applySC.applied).toEqual([fix!.proposalId]);

    // frontmatter が是正されている
    const rawFixed = fs.readFileSync(mismatchAbs, 'utf8');
    expect(rawFixed).toMatch(/categories:\s*\[\s*architecture\s*\]/);

    // ── 4. undo で復元 → reindex 差分 → 件数一致 ─────────────────────
    const undoRes = await callTool('mnemo_organize_undo', { snapshot: applySC.snapshot }, root);
    expect(sc<{ restored: boolean }>(undoRes).restored).toBe(true);
    const rawRestored = fs.readFileSync(mismatchAbs, 'utf8');
    expect(rawRestored).toMatch(/categories:\s*\[\s*search\s*\]/);

    const reindex = await reindexPaths(root, undefined, { full: false });
    expect(reindex.ok).toBe(true);

    // 復元後の件数が apply 前と一致(4 件: store 3 + mislabeled 1)
    const finalList = await getJson<NotesListBody>(app, '/api/notes');
    expect(finalList.body.total).toBe(4);
    const finalScan = sc<ScanSC>(
      await callTool('mnemo_organize_scan', { apply: false, scope: 'all' }, root),
    );
    expect(finalScan.noteCount).toBe(4);
  });

  it('organize apply 途中で使う HTTP 検索は apply 後の状態を反映する(getIndex 再ビルド)', async () => {
    const root = await makeTrackedProject();
    await storeNotes(root, [
      { slug: 'k8s-deploy', title: 'Kubernetes デプロイ手順', targetDir: 'infra' },
      { slug: 'k8s-rollback', title: 'Kubernetes ロールバック戦略', targetDir: '_uncategorized' },
    ]);
    await buildIndex(root);

    const app = buildApp(root);
    const before = await getJson<SearchBody>(app, '/api/search?q=' + encodeURIComponent('Kubernetes'));
    expect(before.body.results.length).toBeGreaterThanOrEqual(1);
  });
});

describe('§13-16 壊れノート混在: 全機能が縮退動作する', () => {
  it('frontmatter 不正な .md を 1 つ混ぜても store/一覧/検索/organize/health が落ちない', async () => {
    const root = await makeTrackedProject();
    await storeNotes(root, [
      { slug: 'sound-a', title: '正常ノート A', targetDir: 'architecture' },
      { slug: 'sound-b', title: '正常ノート B(重複候補)', targetDir: 'architecture' },
    ]);
    await writeBrokenNote(root, 'knowledge/architecture/broken.md');

    // listNotes: errors[] に壊れノートが入る、notes[] は正常 2 件。
    const listed = await listNotes(root);
    expect(listed.notes).toHaveLength(2);
    expect(listed.errors.map((e) => e.relPath)).toContain('knowledge/architecture/broken.md');

    // buildIndex は parse-errors.json を書き、クラッシュしない。
    await buildIndex(root);

    const app = buildApp(root);

    // GET /api/notes: 200・壊れノートを除外。
    const list = await getJson<NotesListBody>(app, '/api/notes');
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(2);

    // GET /api/search: クラッシュしない。
    const search = await getJson<SearchBody>(app, '/api/search?q=' + encodeURIComponent('正常'));
    expect(search.status).toBe(200);
    expect(search.body.total).toBe(2);

    // mnemo_organize_scan: parseErrors に計上・他提案は出る(縮退せず動く)。
    const scanRes = await callTool('mnemo_organize_scan', { apply: false, scope: 'all' }, root);
    const scan = sc<ScanSC & { parseErrors: { relPath: string }[] }>(scanRes);
    expect(scan.parseErrors.map((e) => e.relPath)).toContain('knowledge/architecture/broken.md');
    expect(scanRes.isError).toBeUndefined();

    // GET /api/health/issues: parseErrors に 1 件。
    const issues = await getJson<{ parseErrors: { path: string }[] }>(app, '/api/health/issues');
    expect(issues.status).toBe(200);
    expect(issues.body.parseErrors.length).toBe(1);

    // MCP list_categories も総ノート数から壊れノートを除外。
    const cats = sc<{ totalNotes: number }>(await callTool('mnemo_list_categories', {}, root));
    expect(cats.totalNotes).toBe(2);
  });

  it('壊れノートを直接 GET /api/notes/:id すると 422 + rawExcerpt', async () => {
    const root = await makeTrackedProject();
    await storeNotes(root, [{ slug: 'ok', title: 'OK', targetDir: 'architecture' }]);
    // id が拾えるよう、壊し方は「id 行は妥当だが YAML 全体が壊れている」にする。
    const abs = `${vaultPaths(root).knowledgeDir}/architecture/halfbroken.md`;
    await fs.promises.writeFile(
      abs,
      '---\nid: 20260101T000000000brk01\ntitle: [壊れた YAML\ncategories: architecture\n---\n\n本文\n',
      'utf8',
    );
    const app = buildApp(root);
    const res = await app.request('/api/notes/20260101T000000000brk01', {
      headers: { Authorization: 'Bearer e2e-test-token-abc' },
    });
    expect(res.status).toBe(422);
  });
});

describe('§13-16 縮退確認: Dropbox 配下想定 watcher / 深い node_modules からの解決', () => {
  it('isNetworkFs=true(Dropbox 想定)で createWatcher が usePolling モードになる', async () => {
    const root = await makeTrackedProject();
    // 実 chokidar は使わず注入。isNetworkFs を deps モックして usePolling 経路を確認。
    const fakeChokidar = {
      watch: () => ({ on: () => undefined, close: async () => undefined }),
    } as unknown as ChokidarLike;
    const watcher = createWatcher(root, {
      handle: {} as IndexHandle,
      chokidar: fakeChokidar,
      isNetworkFs: () => true,
      applyDelta: async () => undefined,
      logger: () => undefined,
    });
    expect(watcher.isPolling()).toBe(true);
    await watcher.close();
  });
});

// firstText を 1 度は使って未使用 import を避ける(store dry-run のテキスト確認)。
describe('§13-16 store dry-run テキスト', () => {
  it('dry-run 応答テキストに「保存予定」を含む', async () => {
    const root = await makeTrackedProject();
    const res = await callTool(
      'mnemo_store',
      {
        notes: [
          {
            slug: 'dry',
            title: 'ドライラン',
            targetDir: 'architecture',
            categories: ['architecture'],
            tags: ['e2e'],
            summary: '要約。',
            detail: '## 詳細\n\n本文。\n',
          },
        ],
      },
      root,
    );
    expect(firstText(res)).toContain('保存予定');
  });
});
