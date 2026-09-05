// src/core/search.ts — MiniSearch のビルド / JSON キャッシュ / 差分更新 / 検索実行(設計書 §6-1〜§6-6)。
//
// MiniSearch 7.x 前提(設計 §5-2 / §5-3 / §6-3):
//   - index 時 : `processTerm(term, fieldName)` … `options.processTerm = processTermIndex`
//   - search 時: `processTerm(term)`(field なし)… `searchOptions.processTerm = processTermSearch` を明示
//   `loadJSON(json, options)` の `options` は index 時と完全一致させる(渡し忘れると検索結果が壊れる)。
//
// インデックスファイル(search-index.json / meta.json / parse-errors.json)の書き込みは
// すべて `withLock(projectRoot, 'index')` の内側で行う(設計 §6-3)。読み取り(`loadIndex` /
// `search`)はロック不要(書き込みは tmp+rename で原子的)。

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import MiniSearch from 'minisearch';
import type { Options, SearchResult as MsSearchResult } from 'minisearch';
import { MnemoError } from './errors.js';
import type { Frontmatter } from './frontmatter.js';
import { withLock } from './lock.js';
import { listNotes, readNote } from './note.js';
import { mnemothecaPaths, vaultPaths } from './paths.js';
import {
  processTermIndex,
  processTermSearch,
  TOKENIZER_VERSION,
  tokenize,
} from './tokenizer.js';

/** `search-index.json` の形式バージョン(設計 §6-1 の `v`)。 */
export const SEARCH_INDEX_FORMAT_VERSION = 1;

/** `meta.json` のフィールド構成バージョン(設計 §6-2 の `schemaVersion`)。fields/storeFields を変えたら +1。 */
export const SCHEMA_VERSION = 1;

/** インデックス対象フィールド(設計 §5-4)。`tags` は join(' ')、`categories` は全セグメント ' ' 連結。 */
export const INDEX_FIELDS = ['title', 'summary', 'tags', 'categories', 'content'] as const;

/** 検索結果に含める格納フィールド(設計 §5-4)。 */
export const STORE_FIELDS = [
  'id',
  'title',
  'summary',
  'categories',
  'tags',
  'created',
  'updated',
  'path',
] as const;

/** MiniSearch に投入する 1 ドキュメント(設計 §5-4)。 */
export interface StoredDoc {
  id: string;
  title: string;
  summary: string;
  /** 配列で保持し、`extractField` が index / store 時に ' ' 連結する。 */
  tags: string[];
  /** 同上(カテゴリ経路の全セグメント)。 */
  categories: string[];
  /** frontmatter 除去後の本文全体。 */
  content: string;
  created: string;
  updated: string;
  /** vault ルート相対・POSIX(`knowledge/...`)。 */
  path: string;
}

/** `meta.json` スキーマ(設計 §6-2)。 */
export interface IndexMeta {
  v: number;
  schemaVersion: number;
  tokenizerVersion: number;
  fields: string[];
  storeFields: string[];
  builtAt: string;
  docCount: number;
  /** key = vault 相対パス、value = frontmatter id と mtimeMs。 */
  docs: Record<string, { id: string; mtimeMs: number }>;
}

/** `loadIndex` / `buildIndex` の戻り値(設計 §6-3)。 */
export interface IndexHandle {
  ms: MiniSearch<StoredDoc>;
  meta: IndexMeta;
  projectRoot: string;
}

/** `core/search.search` の 1 件(設計 §6-3。`snippet` / `matchedFields` の整形は呼び出し側の責務)。 */
export interface NoteSearchResult {
  id: string;
  score: number;
  /** マッチした派生 term(bigram 含む)。 */
  terms: string[];
  title: string;
  summary: string;
  categories: string[];
  tags: string[];
  created: string;
  updated: string;
  /** vault 相対パス。 */
  path: string;
}

/** `search` のオプション(設計 §6-3)。 */
export interface SearchOpts {
  limit?: number;
  category?: string;
  tag?: string;
}

const DEFAULT_LIMIT = 30;

/** 配列フィールドは ' ' 連結して index / store する(設計 §5-4)。それ以外はそのまま。 */
function extractField(document: StoredDoc, fieldName: string): unknown {
  const value = (document as unknown as Record<string, unknown>)[fieldName];
  return Array.isArray(value) ? value.join(' ') : value;
}

/**
 * MiniSearch の構築 / `loadJSON` 復元で使う **単一の** オプション定義(設計 §5-3 / §6-3)。
 * `loadJSON` にも必ずこれを渡す(`searchOptions.processTerm = processTermSearch` を含む)。
 */
export function buildMiniSearchOptions(): Options<StoredDoc> {
  return {
    fields: [...INDEX_FIELDS],
    storeFields: [...STORE_FIELDS],
    idField: 'id',
    extractField,
    tokenize,
    processTerm: processTermIndex,
    searchOptions: {
      combineWith: 'AND',
      fuzzy: false,
      prefix: (term: string) => /^[a-z0-9]/.test(term),
      boost: { title: 3, summary: 2, tags: 2, categories: 2, content: 1 },
      tokenize,
      processTerm: processTermSearch,
    },
  };
}

function toDoc(fm: Frontmatter, relPath: string, body: string): StoredDoc {
  return {
    id: fm.id,
    title: fm.title ?? '',
    summary: fm.summary ?? '',
    tags: Array.isArray(fm.tags) ? fm.tags : [],
    categories: Array.isArray(fm.categories) ? fm.categories : [],
    content: body,
    created: fm.created ?? '',
    updated: fm.updated ?? '',
    path: relPath,
  };
}

// ---------------------------------------------------------------------------
// 永続化(すべて呼び出し側の 'index' ロック内で呼ぶこと)
// ---------------------------------------------------------------------------

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${randomBytes(6).toString('hex')}`);
  try {
    await fs.promises.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await fs.promises.rename(tmp, filePath);
  } finally {
    await fs.promises.rm(tmp, { force: true }).catch(() => {
      /* 掃除失敗は致命的でない */
    });
  }
}

async function persistIndex(h: IndexHandle): Promise<void> {
  const paths = mnemothecaPaths(h.projectRoot);
  await writeJsonAtomic(paths.searchIndexJson, {
    v: SEARCH_INDEX_FORMAT_VERSION,
    tokenizerVersion: TOKENIZER_VERSION,
    minisearch: h.ms.toJSON(),
  });
  await writeJsonAtomic(paths.metaJson, h.meta);
}

interface CollectedParseError {
  relPath: string;
  message: string;
  kind: 'frontmatter' | 'invariant' | 'schema';
}

function parseErrorKind(code: string): CollectedParseError['kind'] {
  if (code === 'FRONTMATTER_SCHEMA') return 'schema';
  if (code === 'CATEGORY_INVARIANT') return 'invariant';
  return 'frontmatter';
}

async function writeParseErrors(projectRoot: string, errors: CollectedParseError[]): Promise<void> {
  const paths = mnemothecaPaths(projectRoot);
  const now = new Date().toISOString();
  const payload = errors.map((e) => ({
    path: e.relPath,
    detectedAt: now,
    message: e.message,
    kind: e.kind,
  }));
  await writeJsonAtomic(paths.parseErrorsJson, payload);
}

function freshMeta(docs: IndexMeta['docs']): IndexMeta {
  return {
    v: 1,
    schemaVersion: SCHEMA_VERSION,
    tokenizerVersion: TOKENIZER_VERSION,
    fields: [...INDEX_FIELDS],
    storeFields: [...STORE_FIELDS],
    builtAt: new Date().toISOString(),
    docCount: Object.keys(docs).length,
    docs,
  };
}

// ---------------------------------------------------------------------------
// buildIndex — 全走査してゼロからビルド(設計 §6-3 / §6-4 / §12-11)
// ---------------------------------------------------------------------------

export async function buildIndex(projectRoot: string): Promise<IndexHandle> {
  return withLock(projectRoot, 'index', async () => {
    let listed: Awaited<ReturnType<typeof listNotes>>;
    try {
      listed = await listNotes(projectRoot);
    } catch (err) {
      throw new MnemoError('INDEX_BUILD_FAILED', 'インデックスを構築できませんでした', {
        cause: err instanceof Error ? err.message : String(err),
      });
    }

    const ms = new MiniSearch<StoredDoc>(buildMiniSearchOptions());
    const docs: IndexMeta['docs'] = {};
    const parseErrors: CollectedParseError[] = listed.errors.map((e) => ({
      relPath: e.relPath,
      message: e.message,
      kind: parseErrorKind(e.code),
    }));
    const addedIds = new Set<string>();

    for (const note of listed.notes) {
      let body: string;
      let mtimeMs: number;
      try {
        const parsed = await readNote(note.absPath);
        body = parsed.body;
        mtimeMs = (await fs.promises.stat(note.absPath)).mtimeMs;
      } catch (err) {
        parseErrors.push({
          relPath: note.relPath,
          message: err instanceof Error ? err.message : String(err),
          kind: 'frontmatter',
        });
        continue;
      }

      const doc = toDoc(note.fm, note.relPath, body);
      // 重複 id は後勝ち(設計 §6-3)。
      if (addedIds.has(doc.id)) {
        ms.discard(doc.id);
      }
      ms.add(doc);
      addedIds.add(doc.id);
      docs[note.relPath] = { id: doc.id, mtimeMs };
    }

    const handle: IndexHandle = { ms, meta: freshMeta(docs), projectRoot };
    await persistIndex(handle);
    await writeParseErrors(projectRoot, parseErrors);
    return handle;
  });
}

// ---------------------------------------------------------------------------
// loadIndex — キャッシュから復元。無い / 壊れ / version 不一致は buildIndex(設計 §6-3 / §6-4)
// ---------------------------------------------------------------------------

function isCurrentMeta(meta: unknown): meta is IndexMeta {
  if (typeof meta !== 'object' || meta === null) return false;
  const m = meta as Record<string, unknown>;
  return (
    m['v'] === 1 &&
    m['schemaVersion'] === SCHEMA_VERSION &&
    m['tokenizerVersion'] === TOKENIZER_VERSION &&
    typeof m['docs'] === 'object' &&
    m['docs'] !== null
  );
}

export async function loadIndex(projectRoot: string): Promise<IndexHandle> {
  const paths = mnemothecaPaths(projectRoot);

  let indexRaw: string;
  let metaRaw: string;
  try {
    [indexRaw, metaRaw] = await Promise.all([
      fs.promises.readFile(paths.searchIndexJson, 'utf8'),
      fs.promises.readFile(paths.metaJson, 'utf8'),
    ]);
  } catch {
    return buildIndex(projectRoot);
  }

  let indexJson: { v?: unknown; tokenizerVersion?: unknown; minisearch?: unknown };
  let meta: unknown;
  try {
    indexJson = JSON.parse(indexRaw) as typeof indexJson;
    meta = JSON.parse(metaRaw);
  } catch {
    return buildIndex(projectRoot);
  }

  if (!isCurrentMeta(meta)) return buildIndex(projectRoot);
  if (
    indexJson.v !== SEARCH_INDEX_FORMAT_VERSION ||
    indexJson.tokenizerVersion !== TOKENIZER_VERSION ||
    indexJson.minisearch === undefined
  ) {
    return buildIndex(projectRoot);
  }

  let ms: MiniSearch<StoredDoc>;
  try {
    // ★ index 時と同じ options を渡す(設計 §6-3。渡し忘れると検索結果が壊れる)。
    ms = MiniSearch.loadJSON<StoredDoc>(JSON.stringify(indexJson.minisearch), buildMiniSearchOptions());
  } catch {
    return buildIndex(projectRoot);
  }

  return { ms, meta, projectRoot };
}

// ---------------------------------------------------------------------------
// syncIndex — mtime 比較で added / updated / removed(設計 §6-3)
// ---------------------------------------------------------------------------

export async function syncIndex(
  h: IndexHandle,
): Promise<{ added: number; updated: number; removed: number }> {
  return withLock(h.projectRoot, 'index', async () => {
    const listed = await listNotes(h.projectRoot);
    const seen = new Set<string>();
    const parseErrors: CollectedParseError[] = listed.errors.map((e) => ({
      relPath: e.relPath,
      message: e.message,
      kind: parseErrorKind(e.code),
    }));

    let added = 0;
    let updated = 0;
    let removed = 0;

    for (const note of listed.notes) {
      const rel = note.relPath;
      seen.add(rel);

      let mtimeMs: number;
      try {
        mtimeMs = (await fs.promises.stat(note.absPath)).mtimeMs;
      } catch {
        continue;
      }

      const prev = h.meta.docs[rel];
      if (prev !== undefined && prev.mtimeMs === mtimeMs) continue; // 未変更

      let body: string;
      try {
        body = (await readNote(note.absPath)).body;
      } catch (err) {
        parseErrors.push({
          relPath: rel,
          message: err instanceof Error ? err.message : String(err),
          kind: 'frontmatter',
        });
        if (prev !== undefined) {
          h.ms.discard(prev.id);
          delete h.meta.docs[rel];
          removed += 1;
        }
        continue;
      }

      const doc = toDoc(note.fm, rel, body);
      if (prev !== undefined) {
        h.ms.discard(prev.id);
        updated += 1;
      } else {
        added += 1;
      }
      h.ms.add(doc);
      h.meta.docs[rel] = { id: doc.id, mtimeMs };
    }

    // meta にあるが実ファイル無し → 削除
    for (const rel of Object.keys(h.meta.docs)) {
      if (seen.has(rel)) continue;
      const gone = h.meta.docs[rel];
      if (gone !== undefined) {
        h.ms.discard(gone.id);
        delete h.meta.docs[rel];
        removed += 1;
      }
    }

    if (added + updated + removed > 0) {
      h.meta.docCount = Object.keys(h.meta.docs).length;
      h.meta.builtAt = new Date().toISOString();
      await persistIndex(h);
      await writeParseErrors(h.projectRoot, parseErrors);
    }

    return { added, updated, removed };
  });
}

// ---------------------------------------------------------------------------
// applyDelta — watcher からの単発イベント適用(debounce 済み)(設計 §6-3 / §6-5)
// ---------------------------------------------------------------------------

export async function applyDelta(
  h: IndexHandle,
  ev: { type: 'add' | 'change' | 'unlink'; relPath: string },
): Promise<void> {
  return withLock(h.projectRoot, 'index', async () => {
    const rel = ev.relPath;
    if (!rel.endsWith('.md')) return;

    const abs = path.join(vaultPaths(h.projectRoot).root, rel);
    const prev = h.meta.docs[rel];

    const persistIfChanged = async (): Promise<void> => {
      h.meta.docCount = Object.keys(h.meta.docs).length;
      h.meta.builtAt = new Date().toISOString();
      await persistIndex(h);
    };

    if (ev.type === 'unlink') {
      if (prev === undefined) return;
      h.ms.discard(prev.id);
      delete h.meta.docs[rel];
      await persistIfChanged();
      return;
    }

    let fm: Frontmatter;
    let body: string;
    let mtimeMs: number;
    try {
      const parsed = await readNote(abs);
      fm = parsed.fm;
      body = parsed.body;
      mtimeMs = (await fs.promises.stat(abs)).mtimeMs;
    } catch {
      // 読めない / 壊れている → 既存エントリがあれば落とす
      if (prev !== undefined) {
        h.ms.discard(prev.id);
        delete h.meta.docs[rel];
        await persistIfChanged();
      }
      return;
    }

    const doc = toDoc(fm, rel, body);
    if (prev !== undefined) h.ms.discard(prev.id);
    h.ms.add(doc);
    h.meta.docs[rel] = { id: doc.id, mtimeMs };
    await persistIfChanged();
  });
}

// ---------------------------------------------------------------------------
// search — 検索実行(設計 §5-3 / §6-3)
// ---------------------------------------------------------------------------

/**
 * クエリを `tokenize` + `processTermSearch` に通し、残った検索 term を返す(設計 §5-3)。
 * query は NFKC 正規化・trim 済みを渡す想定だが、保険で正規化する。
 */
export function searchableQueryTerms(query: string): string[] {
  const normalized = query.normalize('NFKC').trim();
  if (normalized === '') return [];
  const out: string[] = [];
  for (const token of tokenize(normalized)) {
    const term = processTermSearch(token);
    if (term !== null && term !== '') out.push(term);
  }
  return out;
}

/**
 * `processTermSearch` 適用後の term が 0 件か(設計 §5-3 / §13-8)。
 * 真なら呼び出し側(HTTP routes / CLI)が `QUERY_TOO_SHORT`(400)を投げる。
 * `search()` 自身は throw せず空配列を返す。
 */
export function isQueryTooShort(query: string): boolean {
  return searchableQueryTerms(query).length === 0;
}

function splitStored(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string' && value.trim() !== '') return value.split(/\s+/);
  return [];
}

export function search(h: IndexHandle, query: string, opts?: SearchOpts): NoteSearchResult[] {
  // 呼び出し側が忘れられないよう、search 時も processTermSearch を明示的に渡す(設計 §5-3)。
  if (isQueryTooShort(query)) return [];

  const raw: MsSearchResult[] = h.ms.search(query, {
    combineWith: 'AND',
    fuzzy: false,
    prefix: (term: string) => /^[a-z0-9]/.test(term),
    boost: { title: 3, summary: 2, tags: 2, categories: 2, content: 1 },
    tokenize,
    processTerm: processTermSearch,
  });

  const limit = opts?.limit ?? DEFAULT_LIMIT;
  const results: NoteSearchResult[] = [];

  for (const r of raw) {
    const rec = r as unknown as Record<string, unknown>;
    const categories = splitStored(rec['categories']);
    const tags = splitStored(rec['tags']);

    if (opts?.category !== undefined && !categories.includes(opts.category)) continue;
    if (opts?.tag !== undefined && !tags.includes(opts.tag)) continue;

    results.push({
      id: String(r.id),
      score: r.score,
      terms: r.terms,
      title: typeof rec['title'] === 'string' ? (rec['title'] as string) : '',
      summary: typeof rec['summary'] === 'string' ? (rec['summary'] as string) : '',
      categories,
      tags,
      created: typeof rec['created'] === 'string' ? (rec['created'] as string) : '',
      updated: typeof rec['updated'] === 'string' ? (rec['updated'] as string) : '',
      path: typeof rec['path'] === 'string' ? (rec['path'] as string) : '',
    });

    if (results.length >= limit) break;
  }

  return results;
}
