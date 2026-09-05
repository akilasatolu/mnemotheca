// test/server/routes/search.test.ts — 設計 §10-1 / §10-4 / §5-3 / §13-13。
//
// `createSearchRoutes` を `createApp` にマウントし、`app.request()` で `/api/search` を叩く。

import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Frontmatter } from '../../../src/core/frontmatter.js';
import { noteAbsPathForCategory, noteRelPath, writeNote } from '../../../src/core/note.js';
import { buildIndex, loadIndex } from '../../../src/core/search.js';
import { createApp } from '../../../src/server/app.js';
import { createSearchRoutes, type SearchRoutesDeps } from '../../../src/server/routes/search.js';
import { makeProject } from '../../helpers/project.js';

const TOKEN = 'test-search-token';
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
  return `20260901T093015${String(idCounter).padStart(3, '0')}ab`;
}

function fm(overrides: Partial<Frontmatter> = {}): Frontmatter {
  return {
    id: nextId(),
    title: 'タイトル',
    categories: ['architecture'],
    tags: ['aws', 'mcp'],
    created: '2026-09-01T09:30:15+09:00',
    updated: '2026-09-01T09:30:15+09:00',
    summary: '要約テキスト',
    source: 'claude-desktop',
    ...overrides,
  };
}

async function addNote(
  root: string,
  cat: string,
  slug: string,
  overrides: Partial<Frontmatter>,
  body: string,
): Promise<string> {
  const abs = noteAbsPathForCategory(root, cat, slug);
  await writeNote(abs, fm({ categories: [cat], ...overrides }), body);
  return noteRelPath(root, abs);
}

function mountApp(root: string, over: Partial<SearchRoutesDeps> = {}) {
  const deps: SearchRoutesDeps = {
    projectRoot: root,
    getIndex: () => loadIndex(root),
    ...over,
  };
  const api = new Hono();
  api.route('/search', createSearchRoutes(deps));
  return createApp(
    { projectRoot: root, token: TOKEN, port: 4711, startedAt: new Date().toISOString() },
    api,
  );
}

const auth = { Authorization: `Bearer ${TOKEN}` };

interface SearchBody {
  query: string;
  took: number;
  total: number;
  results: {
    id: string;
    title: string;
    score: number;
    matchedFields: string[];
    snippet: string;
    categories: string[];
    path: string;
  }[];
}

describe('GET /api/search — 正常系(§13-13)', () => {
  it('ヒットあり: q="機械学習" → results 配列 / score 降順 / matchedFields / took', async () => {
    const root = await mkProject();
    await addNote(root, 'ml', 'a', { title: '機械学習ノート' }, '## 詳細\n\n機械学習の応用事例と評価\n');
    await addNote(root, 'ml', 'b', { title: '無関係' }, '## 詳細\n\n料理のレシピ\n');
    await addNote(root, 'architecture', 'c', {}, '## 詳細\n\n機械学習を使った設計\n');
    await buildIndex(root);

    const res = await mountApp(root).request('/api/search?q=' + encodeURIComponent('機械学習'), {
      headers: auth,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchBody;

    expect(body.query).toBe('機械学習');
    expect(typeof body.took).toBe('number');
    expect(body.results.length).toBe(2);
    expect(body.total).toBe(2);
    // score 降順
    for (let i = 1; i < body.results.length; i += 1) {
      expect(body.results[i - 1]!.score).toBeGreaterThanOrEqual(body.results[i]!.score);
    }
    expect(body.results[0]!.matchedFields.length).toBeGreaterThan(0);
    expect(body.results.map((r) => r.id)).not.toContain(
      body.results.find((r) => r.title === '無関係')?.id,
    );
  });

  it('snippet: 本文マッチ周辺を <mark> で強調し HTML エスケープ済み', async () => {
    const root = await mkProject();
    await addNote(
      root,
      'ml',
      'a',
      { title: 'A' },
      '## 詳細\n\n前置き前置き前置き。ここで <script> 機械学習 の応用について述べる。後書き後書き。\n',
    );
    await buildIndex(root);

    const res = await mountApp(root).request('/api/search?q=' + encodeURIComponent('機械学習'), {
      headers: auth,
    });
    const body = (await res.json()) as SearchBody;
    const snip = body.results[0]!.snippet;
    expect(snip).toContain('<mark>機械学習</mark>');
    expect(snip).toContain('&lt;script&gt;');
    expect(snip).not.toContain('<script>');
  });

  it('category フィルタで絞り込める', async () => {
    const root = await mkProject();
    await addNote(root, 'ml', 'a', { categories: ['ml'] }, '## 詳細\n\n機械学習の基礎\n');
    await addNote(root, 'architecture', 'b', { categories: ['architecture'] }, '## 詳細\n\n機械学習の設計\n');
    await buildIndex(root);

    const app = mountApp(root);
    const all = (await (await app.request('/api/search?q=' + encodeURIComponent('機械学習'), { headers: auth })).json()) as SearchBody;
    expect(all.results.length).toBe(2);

    const filtered = (await (
      await app.request('/api/search?q=' + encodeURIComponent('機械学習') + '&category=ml', { headers: auth })
    ).json()) as SearchBody;
    expect(filtered.results.length).toBe(1);
    expect(filtered.results[0]!.categories).toEqual(['ml']);
  });

  it('limit で結果件数を制限しつつ total は全件を返す', async () => {
    const root = await mkProject();
    for (let i = 0; i < 5; i += 1) {
      await addNote(root, 'ml', `n${i}`, {}, `## 詳細\n\n機械学習の応用 ${i}\n`);
    }
    await buildIndex(root);

    const body = (await (
      await mountApp(root).request('/api/search?q=' + encodeURIComponent('機械学習') + '&limit=2', { headers: auth })
    ).json()) as SearchBody;
    expect(body.results.length).toBe(2);
    expect(body.total).toBe(5);
  });
});

describe('GET /api/search — 助詞 / 短すぎクエリの回帰(§5-3 / §13-13)', () => {
  it('q="a"(英語ストップワード 1 文字)→ 400 QUERY_TOO_SHORT', async () => {
    const root = await mkProject();
    await buildIndex(root);
    const res = await mountApp(root).request('/api/search?q=a', { headers: auth });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('QUERY_TOO_SHORT');
  });

  it('q="の"(助詞のみ)→ 400 QUERY_TOO_SHORT', async () => {
    const root = await mkProject();
    await buildIndex(root);
    const res = await mountApp(root).request('/api/search?q=' + encodeURIComponent('の'), { headers: auth });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('QUERY_TOO_SHORT');
  });

  it('q 未指定 → 400 QUERY_TOO_SHORT', async () => {
    const root = await mkProject();
    await buildIndex(root);
    const res = await mountApp(root).request('/api/search', { headers: auth });
    expect(res.status).toBe(400);
  });

  it('「機械学習 の 応用」→ ルート経由でも 0 件にならない(助詞 "の" が必須語に残らない)', async () => {
    const root = await mkProject();
    await addNote(root, 'ml', 'a', { title: 'ノートA' }, '## 詳細\n\n機械学習の応用事例\n');
    await addNote(root, 'ml', 'b', { title: 'ノートB' }, '## 詳細\n\n料理の話\n');
    await buildIndex(root);

    const res = await mountApp(root).request(
      '/api/search?q=' + encodeURIComponent('機械学習 の 応用'),
      { headers: auth },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchBody;
    expect(body.results.length).toBe(1);
    expect(body.results[0]!.title).toBe('ノートA');
  });
});

describe('GET /api/search — インデックス未構築 / 認証(§13-13)', () => {
  it('インデックス未構築でも loadIndex が自動ビルドし 200 で空結果', async () => {
    const root = await mkProject(); // buildIndex を呼ばない
    const res = await mountApp(root).request('/api/search?q=' + encodeURIComponent('機械学習'), {
      headers: auth,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchBody;
    expect(body.results).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('トークン無し → 401(createApp の認証)', async () => {
    const root = await mkProject();
    await buildIndex(root);
    const res = await mountApp(root).request('/api/search?q=' + encodeURIComponent('機械学習'));
    expect(res.status).toBe(401);
  });
});
