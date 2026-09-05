// test/server/routes/notes.test.ts — 設計 §10-1 / DTO / §13-13 / §13-13b。
//
// `createNotesRoutes` / `createCategoriesRoutes` を `createApp` にマウントし、
// `app.request()` で `/api/notes*` / `/api/categories` を叩く。

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Frontmatter } from '../../../src/core/frontmatter.js';
import { noteAbsPathForCategory, noteRelPath, writeNote } from '../../../src/core/note.js';
import { vaultPaths } from '../../../src/core/paths.js';
import { createApp } from '../../../src/server/app.js';
import { createNotesRoutes } from '../../../src/server/routes/notes.js';
import { createCategoriesRoutes } from '../../../src/server/routes/categories.js';
import { makeProject } from '../../helpers/project.js';

const TOKEN = 'test-notes-token';
const auth = { Authorization: `Bearer ${TOKEN}` };
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
  return `20260901T093015000aa${String(idCounter).padStart(3, '0')}`.slice(0, 23);
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
  body = '## 詳細\n\n本文\n',
): Promise<Frontmatter> {
  const front = fm({ categories: [cat], ...overrides });
  await writeNote(noteAbsPathForCategory(root, cat, slug), front, body);
  return front;
}

function mountApp(root: string) {
  const api = new Hono();
  api.route('/notes', createNotesRoutes({ projectRoot: root }));
  api.route('/categories', createCategoriesRoutes({ projectRoot: root }));
  return createApp(
    { projectRoot: root, token: TOKEN, port: 4712, startedAt: new Date().toISOString() },
    api,
  );
}

interface ListBody {
  total: number;
  items: { id: string; title: string; categories: string[]; tags: string[]; created: string; updated: string; path: string }[];
}

// ───────────────────────── GET /api/notes ─────────────────────────

describe('GET /api/notes — 一覧 / フィルタ / ソート / ページング(§13-13)', () => {
  it('全件返し total は全件数、NoteSummary 形', async () => {
    const root = await mkProject();
    await addNote(root, 'architecture', 'a', { title: 'A' });
    await addNote(root, 'ml', 'b', { title: 'B' });
    const res = await mountApp(root).request('/api/notes', { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.total).toBe(2);
    expect(body.items).toHaveLength(2);
    const item = body.items[0]!;
    expect(Object.keys(item).sort()).toEqual(
      ['categories', 'created', 'id', 'path', 'summary', 'tags', 'title', 'updated'].sort(),
    );
    expect(item.path.startsWith('knowledge/')).toBe(true);
  });

  it('?category= でディレクトリ経路フィルタ', async () => {
    const root = await mkProject();
    await addNote(root, 'ml', 'a', {});
    await addNote(root, 'tech/architecture', 'b', {});
    await addNote(root, 'tech/architecture', 'c', {});

    const app = mountApp(root);
    const ml = (await (await app.request('/api/notes?category=ml', { headers: auth })).json()) as ListBody;
    expect(ml.total).toBe(1);
    const arch = (await (
      await app.request('/api/notes?category=' + encodeURIComponent('tech/architecture'), { headers: auth })
    ).json()) as ListBody;
    expect(arch.total).toBe(2);
  });

  it('?tag= でタグフィルタ', async () => {
    const root = await mkProject();
    await addNote(root, 'ml', 'a', { tags: ['aws'] });
    await addNote(root, 'ml', 'b', { tags: ['gcp'] });
    const body = (await (
      await mountApp(root).request('/api/notes?tag=aws', { headers: auth })
    ).json()) as ListBody;
    expect(body.total).toBe(1);
    expect(body.items[0]!.tags).toEqual(['aws']);
  });

  it('?sort=title&order=asc / desc', async () => {
    const root = await mkProject();
    await addNote(root, 'ml', 'a', { title: 'あ' });
    await addNote(root, 'ml', 'b', { title: 'ん' });
    const app = mountApp(root);
    const asc = (await (await app.request('/api/notes?sort=title&order=asc', { headers: auth })).json()) as ListBody;
    expect(asc.items.map((i) => i.title)).toEqual(['あ', 'ん']);
    const desc = (await (await app.request('/api/notes?sort=title&order=desc', { headers: auth })).json()) as ListBody;
    expect(desc.items.map((i) => i.title)).toEqual(['ん', 'あ']);
  });

  it('?sort=created / updated', async () => {
    const root = await mkProject();
    await addNote(root, 'ml', 'a', { title: 'old', created: '2026-01-01T00:00:00+09:00', updated: '2026-12-01T00:00:00+09:00' });
    await addNote(root, 'ml', 'b', { title: 'new', created: '2026-06-01T00:00:00+09:00', updated: '2026-02-01T00:00:00+09:00' });
    const app = mountApp(root);
    const byCreated = (await (await app.request('/api/notes?sort=created&order=asc', { headers: auth })).json()) as ListBody;
    expect(byCreated.items.map((i) => i.title)).toEqual(['old', 'new']);
    const byUpdated = (await (await app.request('/api/notes?sort=updated&order=asc', { headers: auth })).json()) as ListBody;
    expect(byUpdated.items.map((i) => i.title)).toEqual(['new', 'old']);
  });

  it('?limit / ?offset ページング — total は全件', async () => {
    const root = await mkProject();
    for (let i = 0; i < 5; i += 1) {
      await addNote(root, 'ml', `n${i}`, { title: `t${i}`, created: `2026-01-0${i + 1}T00:00:00+09:00` });
    }
    const app = mountApp(root);
    const page = (await (
      await app.request('/api/notes?sort=created&order=asc&limit=2&offset=1', { headers: auth })
    ).json()) as ListBody;
    expect(page.total).toBe(5);
    expect(page.items.map((i) => i.title)).toEqual(['t1', 't2']);
  });

  it('トークン無し → 401', async () => {
    const root = await mkProject();
    const res = await mountApp(root).request('/api/notes');
    expect(res.status).toBe(401);
  });
});

// ───────────────────────── GET /api/notes/:id ─────────────────────────

describe('GET /api/notes/:id(§13-13)', () => {
  it('成功 → { id, frontmatter, body, path }', async () => {
    const root = await mkProject();
    const front = await addNote(root, 'ml', 'a', { title: '詳細ノート' }, '## 要約\n\nすごい\n');
    const res = await mountApp(root).request(`/api/notes/${front.id}`, { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; frontmatter: Frontmatter; body: string; path: string };
    expect(body.id).toBe(front.id);
    expect(body.frontmatter.title).toBe('詳細ノート');
    expect(body.body).toContain('すごい');
    expect(body.path).toBe('knowledge/ml/a.md');
  });

  it('不正な id 形式 → 400', async () => {
    const root = await mkProject();
    const res = await mountApp(root).request('/api/notes/not-an-id', { headers: auth });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INVALID_ID');
  });

  it('形式は正しいが存在しない id → 404', async () => {
    const root = await mkProject();
    const res = await mountApp(root).request('/api/notes/20260101T000000000zzzzz', { headers: auth });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });

  it('壊れた frontmatter のノート → 422 + rawExcerpt', async () => {
    const root = await mkProject();
    const brokenId = '20260101T000000000brk01';
    const raw = `---\nid: ${brokenId}\ntitle: [壊れた YAML\ncategories: ml\n---\n\n本文が続く\n`;
    const abs = path.join(vaultPaths(root).knowledgeDir, 'ml', 'broken.md');
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, raw, 'utf8');

    const res = await mountApp(root).request(`/api/notes/${brokenId}`, { headers: auth });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; details: { rawExcerpt: string } } };
    expect(body.error.details.rawExcerpt).toContain('壊れた YAML');
    expect(body.error.details.rawExcerpt.length).toBeLessThanOrEqual(200);
  });
});

// ───────────────────────── GET /api/notes/:id/rendered ─────────────────────────

describe('GET /api/notes/:id/rendered(§13-13 / §13-13b)', () => {
  it('html + headings、headings[].slug が本文見出しの id と一致(§13-13b)', async () => {
    const root = await mkProject();
    const front = await addNote(
      root,
      'ml',
      'a',
      { title: 'R' },
      '## 機械学習の応用\n\n本文\n\n### 評価方法\n\nくわしく\n',
    );
    const res = await mountApp(root).request(`/api/notes/${front.id}/rendered`, { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      html: string;
      frontmatter: Frontmatter;
      headings: { depth: number; text: string; slug: string }[];
      path: string;
    };
    expect(body.id).toBe(front.id);
    expect(body.frontmatter.title).toBe('R');
    // rendered レスポンスに vault 相対パスが含まれる(NoteViewPage の一覧逆引き廃止のため)。
    expect(body.path).toBe('knowledge/ml/a.md');
    expect(body.headings.length).toBe(2);
    for (const h of body.headings) {
      expect(body.html).toContain(`id="${h.slug}"`);
    }
    expect(body.headings[0]!.depth).toBe(2);
  });

  it('不正 id → 400 / 不在 → 404', async () => {
    const root = await mkProject();
    const app = mountApp(root);
    expect((await app.request('/api/notes/bad/rendered', { headers: auth })).status).toBe(400);
    expect(
      (await app.request('/api/notes/20260101T000000000zzzzz/rendered', { headers: auth })).status,
    ).toBe(404);
  });
});

// ───────────────────────── GET /api/categories ─────────────────────────

describe('GET /api/categories(§13-13 / §13-11b)', () => {
  it('ツリー構造 + noteCount + uncategorizedCount', async () => {
    const root = await mkProject();
    await addNote(root, 'architecture', 'a', {});
    await addNote(root, 'architecture', 'b', {});
    await addNote(root, 'tech/db', 'c', {});
    await addNote(root, '_uncategorized', 'u', { categories: ['_uncategorized'] });

    const res = await mountApp(root).request('/api/categories', { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tree: { path: string; name: string; title: string; noteCount: number; children: unknown[] }[];
      uncategorizedCount: number;
    };
    expect(body.uncategorizedCount).toBe(1);

    const arch = body.tree.find((n) => n.path === 'architecture')!;
    expect(arch.noteCount).toBe(2);
    expect(arch.name).toBe('architecture');

    const tech = body.tree.find((n) => n.path === 'tech')!;
    expect(tech.noteCount).toBe(0);
    expect(tech.children).toHaveLength(1);
    expect((tech.children[0] as { path: string; noteCount: number }).path).toBe('tech/db');
    expect((tech.children[0] as { noteCount: number }).noteCount).toBe(1);
  });

  it('categories/<path>.md の title を表示名に採用', async () => {
    const root = await mkProject();
    await addNote(root, 'architecture', 'a', {});
    await fs.promises.writeFile(
      path.join(vaultPaths(root).categoriesDir, 'architecture.md'),
      '---\ntitle: アーキテクチャ\n---\n\n# アーキテクチャ\n',
      'utf8',
    );
    const body = (await (
      await mountApp(root).request('/api/categories', { headers: auth })
    ).json()) as { tree: { path: string; title: string }[] };
    expect(body.tree.find((n) => n.path === 'architecture')!.title).toBe('アーキテクチャ');
  });

  it('空 vault → tree 空 / uncategorizedCount 0', async () => {
    const root = await mkProject();
    const body = (await (
      await mountApp(root).request('/api/categories', { headers: auth })
    ).json()) as { tree: unknown[]; uncategorizedCount: number };
    expect(body.tree).toEqual([]);
    expect(body.uncategorizedCount).toBe(0);
  });

  it('壊れたノートが混在しても落ちない', async () => {
    const root = await mkProject();
    await addNote(root, 'ml', 'a', {});
    await fs.promises.writeFile(
      path.join(vaultPaths(root).knowledgeDir, 'ml', 'broken.md'),
      '---\nid: [oops\n---\nx\n',
      'utf8',
    );
    const res = await mountApp(root).request('/api/categories', { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tree: { path: string; noteCount: number }[] };
    expect(body.tree.find((n) => n.path === 'ml')!.noteCount).toBe(1);
  });
});
