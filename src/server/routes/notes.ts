// src/server/routes/notes.ts — `GET /api/notes` 系(設計 §10-1 エンドポイント表 / DTO / §13-13)。
//
// 責務(薄いルート):
//   - `GET /api/notes`         … 一覧 + `?category` / `?tag` フィルタ、`?sort` / `?order`
//                                 ソート、`?limit` / `?offset` ページング。`total` は全件数。
//   - `GET /api/notes/:id`     … 生 Markdown + frontmatter。`:id` は `core/id.ID_PATTERN` で
//                                 検証(不一致 → 400)、不在 → 404、壊れた frontmatter →
//                                 422 + `details.rawExcerpt`(設計 §11-4「NoteViewPage で
//                                 当該ノートを開いた場合 … 422 + details: { rawExcerpt, message }」)。
//   - `GET /api/notes/:id/rendered` … サニタイズ済み HTML。`server/markdown.render` 経由で、
//                                 `headings` は `render` の戻り値をそのまま透過する
//                                 (§13-13b: `headings[].slug` は見出し `id` と一致)。
//
// 結線は `src/server/mount.ts` の `mountApiRoutes` が `api.route('/notes', createNotesRoutes(deps))` で行う。
//
// 規約: ESM / NodeNext / strict / verbatimModuleSyntax / noUncheckedIndexedAccess。

import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Frontmatter } from '../../core/frontmatter.js';
import { ID_PATTERN } from '../../core/id.js';
import { listNotes, readNote, type NoteError, type NoteRef } from '../../core/note.js';
import { vaultPaths } from '../../core/paths.js';
import { render } from '../markdown.js';

/** `createNotesRoutes` の依存(結線タスク / boot.ts が生成して渡す)。 */
export interface NotesRoutesDeps {
  /** projectRoot 絶対パス。 */
  projectRoot: string;
}

/** §10-1 DTO。`NoteSummary`。 */
export interface NoteSummary {
  id: string;
  title: string;
  summary: string;
  categories: string[];
  tags: string[];
  created: string;
  updated: string;
  path: string;
}

interface NoteListResponse {
  total: number;
  items: NoteSummary[];
}

const SORT_KEYS = ['created', 'updated', 'title'] as const;
type SortKey = (typeof SORT_KEYS)[number];
const RAW_EXCERPT_LEN = 200;

function errorBody(code: string, message: string, details: Record<string, unknown> = {}) {
  return { error: { code, message, details } };
}

/** ノートの vault 相対パス(`knowledge/<...>/<slug>.md`)→ `knowledge/` 相対のカテゴリ経路。 */
function categoryPathOf(relPath: string): string {
  const parts = relPath.split('/');
  // parts[0] === 'knowledge'、最後はファイル名。
  return parts.slice(1, -1).join('/');
}

function strOf(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function strArrayOf(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function toSummary(note: NoteRef): NoteSummary {
  const fm = note.fm;
  return {
    id: strOf(fm.id) || note.id,
    title: strOf(fm.title),
    summary: strOf(fm.summary),
    categories: strArrayOf(fm.categories),
    tags: strArrayOf(fm.tags),
    created: strOf(fm.created),
    updated: strOf(fm.updated),
    path: note.relPath,
  };
}

function parseSort(raw: string | undefined): SortKey {
  return (SORT_KEYS as readonly string[]).includes(raw ?? '') ? (raw as SortKey) : 'updated';
}

/** 非負整数のみ受理。負数 / 非数 / 未指定 → `undefined`。 */
function parseNonNegInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return undefined;
  return n;
}

/**
 * 一覧結果を `?category` / `?tag` で絞り込む。
 * - `category`: `knowledge/` 相対のカテゴリ経路(ディレクトリ)一致。`_uncategorized` /
 *   空文字はいずれも未分類ノートにマッチさせる。
 * - `tag`: `tags[]` に完全一致する要素を持つ。
 */
function applyFilters(items: NoteSummary[], category: string | undefined, tag: string | undefined): NoteSummary[] {
  let out = items;
  if (category !== undefined) {
    const want = category === '' ? '_uncategorized' : category;
    out = out.filter((n) => {
      const cp = categoryPathOf(n.path);
      const norm = cp === '' ? '_uncategorized' : cp;
      return norm === want;
    });
  }
  if (tag !== undefined && tag !== '') {
    out = out.filter((n) => n.tags.includes(tag));
  }
  return out;
}

function sortItems(items: NoteSummary[], sort: SortKey, order: 'asc' | 'desc'): NoteSummary[] {
  const dir = order === 'asc' ? 1 : -1;
  const cmp = (a: NoteSummary, b: NoteSummary): number => {
    if (sort === 'title') {
      const t = a.title.localeCompare(b.title, 'ja');
      return t !== 0 ? t : a.id.localeCompare(b.id);
    }
    const av = sort === 'created' ? a.created : a.updated;
    const bv = sort === 'created' ? b.created : b.updated;
    if (av < bv) return -1;
    if (av > bv) return 1;
    return a.id.localeCompare(b.id);
  };
  return [...items].sort((a, b) => dir * cmp(a, b));
}

/** 壊れたノートを含めて id からノートを引く。 */
type Located =
  | { kind: 'ok'; note: NoteRef }
  | { kind: 'broken'; relPath: string; raw: string; message: string }
  | { kind: 'missing' };

/** 壊れたノートの raw frontmatter からゆるく `id:` を取り出す(スキーマ検証はしない)。 */
function looseFrontmatterId(raw: string): string | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  const block = m?.[1] ?? raw;
  const line = /^id:[ \t]*["']?([^"'\r\n]+?)["']?[ \t]*$/m.exec(block);
  return line?.[1]?.trim() ?? null;
}

async function locate(projectRoot: string, id: string): Promise<Located> {
  const { notes, errors } = await listNotes(projectRoot);
  const hit = notes.find((n) => strOf(n.fm.id) === id);
  if (hit !== undefined) return { kind: 'ok', note: hit };

  const vaultRoot = vaultPaths(projectRoot).root;
  for (const err of errors as NoteError[]) {
    let raw: string;
    try {
      raw = await fs.promises.readFile(path.join(vaultRoot, err.relPath), 'utf8');
    } catch {
      continue;
    }
    if (looseFrontmatterId(raw) === id) {
      return { kind: 'broken', relPath: err.relPath, raw, message: err.message };
    }
  }
  return { kind: 'missing' };
}

function brokenResponse(c: Context, located: Extract<Located, { kind: 'broken' }>): Response {
  return c.json(
    errorBody('FRONTMATTER_PARSE', 'このノートの frontmatter を解析できません。', {
      rawExcerpt: located.raw.slice(0, RAW_EXCERPT_LEN),
      message: located.message,
      path: located.relPath,
    }),
    422 satisfies ContentfulStatusCode,
  );
}

export function createNotesRoutes(deps: NotesRoutesDeps): Hono {
  const r = new Hono();

  // --- GET /api/notes ---
  r.get('/', async (c) => {
    const { notes } = await listNotes(deps.projectRoot);
    const all = notes.map(toSummary);

    const category = c.req.query('category');
    const tag = c.req.query('tag');
    const filtered = applyFilters(all, category, tag);

    const sort = parseSort(c.req.query('sort'));
    const order: 'asc' | 'desc' = c.req.query('order') === 'asc' ? 'asc' : 'desc';
    const sorted = sortItems(filtered, sort, order);

    const offset = parseNonNegInt(c.req.query('offset')) ?? 0;
    const limit = parseNonNegInt(c.req.query('limit'));
    const paged = limit === undefined ? sorted.slice(offset) : sorted.slice(offset, offset + limit);

    const body: NoteListResponse = { total: filtered.length, items: paged };
    return c.json(body);
  });

  // --- GET /api/notes/:id/rendered ---
  r.get('/:id/rendered', async (c) => {
    const id = c.req.param('id');
    if (!ID_PATTERN.test(id)) {
      return c.json(errorBody('INVALID_ID', 'ノート id の形式が不正です。', { id }), 400);
    }
    const located = await locate(deps.projectRoot, id);
    if (located.kind === 'missing') {
      return c.json(errorBody('NOT_FOUND', '該当するノートがありません。', { id }), 404);
    }
    if (located.kind === 'broken') return brokenResponse(c, located);

    const { note } = located;
    const parsed = await readNote(note.absPath);
    const { html, headings } = await render(parsed.body);
    return c.json({
      id,
      html,
      frontmatter: note.fm as Frontmatter,
      headings,
      path: note.relPath,
    });
  });

  // --- GET /api/notes/:id ---
  r.get('/:id', async (c) => {
    const id = c.req.param('id');
    if (!ID_PATTERN.test(id)) {
      return c.json(errorBody('INVALID_ID', 'ノート id の形式が不正です。', { id }), 400);
    }
    const located = await locate(deps.projectRoot, id);
    if (located.kind === 'missing') {
      return c.json(errorBody('NOT_FOUND', '該当するノートがありません。', { id }), 404);
    }
    if (located.kind === 'broken') return brokenResponse(c, located);

    const { note } = located;
    const parsed = await readNote(note.absPath);
    return c.json({
      id,
      frontmatter: note.fm as Frontmatter,
      body: parsed.body,
      path: note.relPath,
    });
  });

  return r;
}

export default createNotesRoutes;
