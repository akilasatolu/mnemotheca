// src/server/routes/search.ts — `GET /api/search`(設計 §10-1 エンドポイント表 / DTO / §10-4 / §5-3 / §9)。
//
// 責務(薄いルート):
//   - クエリ検証(`isQueryTooShort` → 400 `QUERY_TOO_SHORT`。§5-3 / §13-13)
//   - `core/search.search()` を呼び、結果を `SearchResult`(§10-1 DTO)へ整形
//   - `snippet` 生成(本文中の最初のマッチ周辺 ±60 字を HTML エスケープし、元クエリ語を
//     `<mark>` で囲む。§10-1「DTO」直後の注記)
//   - `matchedFields` の算出(§10-1 DTO)
//
// インデックスハンドルは `deps.getIndex()` 経由で受け取る(boot が保持する live handle、
// または `core/search.loadIndex`。未構築時は `loadIndex` が自動ビルドし、失敗時のみ
// `INDEX_BUILD_FAILED`(→ 503)を投げる。設計 §6-3 / §6-4)。ルート結線は別タスク。

import path from 'node:path';
import { Hono } from 'hono';
import { MnemoError } from '../../core/errors.js';
import { readNote } from '../../core/note.js';
import { vaultPaths } from '../../core/paths.js';
import {
  isQueryTooShort,
  search,
  searchableQueryTerms,
  type IndexHandle,
  type NoteSearchResult,
} from '../../core/search.js';

/** `createSearchRoutes` の依存。ルート結線タスク / boot が用意する。 */
export interface SearchRoutesDeps {
  /** projectRoot 絶対パス(`snippet` 用にノート本文を読む)。 */
  projectRoot: string;
  /** 検索インデックスハンドルを返す(live handle または `core/search.loadIndex`)。 */
  getIndex: () => Promise<IndexHandle>;
}

/** §10-1 DTO。`SearchResult`。 */
interface SearchResultDto {
  id: string;
  title: string;
  summary: string;
  categories: string[];
  tags: string[];
  score: number;
  matchedFields: string[];
  snippet: string;
  path: string;
}

/** §10-1「`GET /api/search`」レスポンス。 */
interface SearchResponse {
  query: string;
  took: number;
  total: number;
  results: SearchResultDto[];
}

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
/** `total` を数えるための実質無制限フェッチ幅。 */
const COUNT_LIMIT = 10_000;
/** snippet のマッチ前後の抽出半径(設計「±60 字」)。 */
const SNIPPET_RADIUS = 60;

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 「元クエリ語」= 空白区切りの生クエリ語のうち、ストップワードのみでない語。
 * bigram ではなく原語で `<mark>` を打つ(設計 §10-1 DTO 注記)。
 */
function queryWords(query: string): string[] {
  return query
    .normalize('NFKC')
    .trim()
    .split(/\s+/)
    .filter((w) => w !== '' && searchableQueryTerms(w).length > 0);
}

/** エスケープ済みテキスト中の(エスケープ済み)クエリ語を 1 パスで `<mark>` 包み。 */
function markAll(escapedText: string, words: string[]): string {
  const escapedWords = words
    .map((w) => escapeRegExp(escapeHtml(w)))
    .filter((w) => w !== '')
    .sort((a, b) => b.length - a.length);
  if (escapedWords.length === 0) return escapedText;
  const re = new RegExp(`(${escapedWords.join('|')})`, 'gi');
  return escapedText.replace(re, '<mark>$1</mark>');
}

/** 本文からマッチ周辺 ±60 字を抽出 → HTML エスケープ → 元クエリ語を `<mark>`。 */
function buildSnippet(body: string, words: string[]): string {
  const hay = body.replace(/\s+/g, ' ').trim();
  if (hay === '') return '';
  const lc = hay.toLowerCase();

  let matchStart = -1;
  let matchLen = 0;
  for (const w of words) {
    const i = lc.indexOf(w.toLowerCase());
    if (i !== -1 && (matchStart === -1 || i < matchStart)) {
      matchStart = i;
      matchLen = w.length;
    }
  }

  let from: number;
  let to: number;
  if (matchStart === -1) {
    from = 0;
    to = Math.min(hay.length, SNIPPET_RADIUS * 2);
  } else {
    from = Math.max(0, matchStart - SNIPPET_RADIUS);
    to = Math.min(hay.length, matchStart + matchLen + SNIPPET_RADIUS);
  }

  const core = markAll(escapeHtml(hay.slice(from, to)), words);
  return `${from > 0 ? '…' : ''}${core}${to < hay.length ? '…' : ''}`;
}

/** どの格納 / 本文フィールドがクエリ term(bigram 含む)を含むか(§10-1 DTO `matchedFields`)。 */
function computeMatchedFields(terms: string[], fields: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [name, text] of Object.entries(fields)) {
    const lc = text.toLowerCase();
    if (terms.some((t) => t !== '' && lc.includes(t))) out.push(name);
  }
  return out;
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

/**
 * `GET /api/search` サブアプリを生成する。結線側は `api.route('/search', createSearchRoutes(deps))`。
 */
export function createSearchRoutes(deps: SearchRoutesDeps): Hono {
  const r = new Hono();
  const vaultRoot = vaultPaths(deps.projectRoot).root;

  r.get('/', async (c) => {
    const started = Date.now();
    const query = c.req.query('q') ?? '';

    if (isQueryTooShort(query)) {
      throw new MnemoError('QUERY_TOO_SHORT', '検索クエリが短すぎます(有効な語が 1 つも残りません)。', {
        q: query,
      });
    }

    const limit = parseLimit(c.req.query('limit'));
    const category = c.req.query('category');
    const tag = c.req.query('tag');

    const handle = await deps.getIndex();
    const all: NoteSearchResult[] = search(handle, query, {
      limit: COUNT_LIMIT,
      ...(category !== undefined ? { category } : {}),
      ...(tag !== undefined ? { tag } : {}),
    });

    const terms = searchableQueryTerms(query);
    const words = queryWords(query);
    const top = all.slice(0, limit);

    const results: SearchResultDto[] = await Promise.all(
      top.map(async (hit) => {
        let body = '';
        try {
          body = (await readNote(path.join(vaultRoot, hit.path))).body;
        } catch {
          body = '';
        }
        const matchedFields = computeMatchedFields(terms, {
          title: hit.title,
          summary: hit.summary,
          tags: hit.tags.join(' '),
          categories: hit.categories.join(' '),
          content: body,
        });
        return {
          id: hit.id,
          title: hit.title,
          summary: hit.summary,
          categories: hit.categories,
          tags: hit.tags,
          score: hit.score,
          matchedFields,
          snippet: buildSnippet(body || hit.summary, words),
          path: hit.path,
        };
      }),
    );

    const payload: SearchResponse = {
      query,
      took: Date.now() - started,
      total: all.length,
      results,
    };
    return c.json(payload);
  });

  return r;
}

export default createSearchRoutes;
