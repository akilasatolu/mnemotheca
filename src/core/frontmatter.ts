// src/core/frontmatter.ts — frontmatter の parse / serialize / スキーマ検証・正規化(設計書 §8-C / §10-2)。
//
// gray-matter で YAML frontmatter を分離し、Mnemo の frontmatter スキーマ(§10-2-1)へ写す。
// YAML キー順は §10-2 で固定: id, title, categories, tags, created, updated, summary, source。
// I/O は行わない(純ロジック)。呼び出し側(core/note・mcp/tools/store・core/reindex)が
// ファイル読み書きを担当する。

import matter from 'gray-matter';
import { MnemoError } from './errors.js';

/** frontmatter スキーマ(設計書 §10-2-1)。 */
export interface Frontmatter {
  /** `newId()` 生成。不変。 */
  id: string;
  /** 日本語可。1〜200 字。 */
  title: string;
  /** `[0]` = ファイルの実ディレクトリ(`knowledge/` 相対)。store 直後は 1 セグメント。 */
  categories: string[];
  /** 検索・ブラウズ用。重複除去・trim 済み。空配列可。 */
  tags: string[];
  /** ISO8601 + TZ。書き込み時刻。不変。 */
  created: string;
  /** ISO8601 + TZ。organize の移動・統合・追記で更新。 */
  updated: string;
  /** 1〜3 文。空文字可。 */
  summary: string;
  /** 取得できたときのみ。省略時は 'unknown' 扱い。 */
  source?: 'claude-desktop' | 'claude-code' | 'unknown';
}

/** `parseNote` の戻り値(設計書 §8-C)。 */
export interface ParsedNote {
  fm: Frontmatter;
  body: string;
  raw: string;
}

/** §10-2 で固定された YAML キー順。`serializeNote` はこの順で出力する。 */
export const FRONTMATTER_KEYS = [
  'id',
  'title',
  'categories',
  'tags',
  'created',
  'updated',
  'summary',
  'source',
] as const;

const SOURCE_VALUES = ['claude-desktop', 'claude-code', 'unknown'] as const;
type SourceValue = (typeof SOURCE_VALUES)[number];

const MAX_TITLE = 200;

// js-yaml(gray-matter 同梱)へ渡す dump オプション。
// - flowLevel: 1 … ルートのマッピングはブロック、その値である配列はフロー(`[a, b]`)で出力
// - lineWidth: -1 … 長いタイトル等を折り返さない
// - noRefs: true  … アンカー/エイリアスを使わない
// gray-matter の型には js-yaml オプションが載っていないためキャストして渡す。
type StringifyOptions = NonNullable<Parameters<typeof matter.stringify>[2]>;
const YAML_DUMP_OPTIONS = {
  flowLevel: 1,
  lineWidth: -1,
  noRefs: true,
} as unknown as StringifyOptions;

/** 実行時の任意オブジェクトとして frontmatter を触るための緩い型。 */
type LooseFrontmatter = Record<string, unknown>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isParseableDate(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Date.parse(v));
}

/**
 * gray-matter で frontmatter を分離する(設計書 §8-C)。
 * frontmatter が無い / YAML が壊れている → `MnemoError('FRONTMATTER_PARSE')`。
 *
 * 注意: js-yaml はタイムスタンプ様の値を `Date` にパースするため、値が `Date` の場合は
 * ISO 文字列へ戻す(タイムゾーン付き文字列で書かれていれば `serializeNote` が引用符で
 * 囲むのでこの経路には入らない)。
 */
export function parseNote(raw: string): ParsedNote {
  let file: matter.GrayMatterFile<string>;
  try {
    file = matter(raw);
  } catch (err) {
    throw new MnemoError('FRONTMATTER_PARSE', 'frontmatter の YAML を解析できません', {
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  const hasDelimiter = matter.test(raw);
  const data = file.data as LooseFrontmatter;
  if (!hasDelimiter || Object.keys(data).length === 0) {
    throw new MnemoError('FRONTMATTER_PARSE', 'frontmatter がありません', {});
  }

  const coerced: LooseFrontmatter = {};
  for (const [k, v] of Object.entries(data)) {
    coerced[k] = v instanceof Date ? v.toISOString() : v;
  }

  return { fm: coerced as unknown as Frontmatter, body: file.content, raw };
}

/**
 * frontmatter + 本文を Markdown 文字列へ戻す(設計書 §8-C / §10-2)。
 * キー順を §10-2 の固定順にし、`categories` / `tags` はフロー配列で出力する。
 */
export function serializeNote(fm: Frontmatter, body: string): string {
  const source = fm as unknown as LooseFrontmatter;
  const ordered: Record<string, unknown> = {};
  for (const key of FRONTMATTER_KEYS) {
    const value = source[key];
    if (key === 'source' && (value === undefined || value === null)) {
      continue;
    }
    if (value === undefined) {
      continue;
    }
    ordered[key] = value;
  }
  return matter.stringify(body, ordered, YAML_DUMP_OPTIONS);
}

/**
 * 「読めるが不正」な frontmatter を弾く(設計書 §8-C / §10-2-1)。
 * 通常は `normalizeFrontmatter` を通した後に呼ぶ。違反 → `MnemoError('FRONTMATTER_SCHEMA')`。
 */
export function validateFrontmatter(fm: unknown): asserts fm is Frontmatter {
  if (!isPlainObject(fm)) {
    throw new MnemoError('FRONTMATTER_SCHEMA', 'frontmatter がオブジェクトではありません', {});
  }

  const fail = (message: string, field: string): never => {
    throw new MnemoError('FRONTMATTER_SCHEMA', message, { field });
  };

  if (typeof fm['id'] !== 'string' || fm['id'].trim() === '') {
    fail('id は非空の文字列である必要があります', 'id');
  }

  const title = fm['title'];
  if (typeof title !== 'string' || title.length < 1) {
    fail('title は非空の文字列である必要があります', 'title');
  } else if (title.length > MAX_TITLE) {
    fail(`title は ${MAX_TITLE} 字以内である必要があります`, 'title');
  }

  const categories = fm['categories'];
  if (!Array.isArray(categories) || categories.length < 1) {
    fail('categories は 1 要素以上の配列である必要があります', 'categories');
  } else if (!categories.every((c): c is string => typeof c === 'string')) {
    fail('categories の要素はすべて文字列である必要があります', 'categories');
  } else if (categories[0] === undefined || categories[0].trim() === '') {
    fail('categories[0] は非空である必要があります', 'categories');
  }

  const tags = fm['tags'];
  if (!Array.isArray(tags) || !tags.every((t): t is string => typeof t === 'string')) {
    fail('tags は文字列の配列である必要があります', 'tags');
  }

  if (!isParseableDate(fm['created'])) {
    fail('created はパース可能な日付文字列である必要があります', 'created');
  }
  if (!isParseableDate(fm['updated'])) {
    fail('updated はパース可能な日付文字列である必要があります', 'updated');
  }

  if (typeof fm['summary'] !== 'string') {
    fail('summary は文字列である必要があります(空文字可)', 'summary');
  }

  const source = fm['source'];
  if (source !== undefined && !SOURCE_VALUES.includes(source as SourceValue)) {
    fail('source は claude-desktop / claude-code / unknown のいずれかである必要があります', 'source');
  }
}

/**
 * frontmatter を正規化する(設計書 §8-C / §10-2-1)。
 * - スカラー `category` → `categories: [value]`(後方互換)
 * - `categories` / `tags` を配列化・trim・空要素除去、`tags` は重複除去(小文字化はしない)
 * - `created > updated` なら `updated = created` に補正
 * - `source` が enum 外なら `'unknown'`
 * - 不採用フィールド(`category` / `aliases` / `cssclasses` 等)を除去
 */
export function normalizeFrontmatter(fm: Frontmatter): Frontmatter {
  const raw = fm as unknown as LooseFrontmatter;
  const out: LooseFrontmatter = {};

  if (typeof raw['id'] === 'string') {
    out['id'] = raw['id'];
  }
  if (typeof raw['title'] === 'string') {
    out['title'] = raw['title'];
  }

  // categories: 配列化(スカラー category からの補完を含む)+ trim + 空要素除去
  let cats: string[] = [];
  if (Array.isArray(raw['categories'])) {
    cats = raw['categories'].filter((c): c is string => typeof c === 'string');
  }
  cats = cats.map((c) => c.trim()).filter((c) => c !== '');
  if (cats.length === 0 && typeof raw['category'] === 'string') {
    const single = raw['category'].trim();
    if (single !== '') {
      cats = [single];
    }
  }
  out['categories'] = cats;

  // tags: trim + 空要素除去 + 重複除去(初出優先)
  const seen = new Set<string>();
  const tags: string[] = [];
  const rawTags = Array.isArray(raw['tags'])
    ? raw['tags'].filter((t): t is string => typeof t === 'string')
    : [];
  for (const t of rawTags) {
    const trimmed = t.trim();
    if (trimmed === '' || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    tags.push(trimmed);
  }
  out['tags'] = tags;

  const created = raw['created'];
  const updated = raw['updated'];
  if (typeof created === 'string') {
    out['created'] = created;
  }
  if (typeof updated === 'string') {
    out['updated'] = updated;
  }
  if (
    typeof created === 'string' &&
    typeof updated === 'string' &&
    isParseableDate(created) &&
    isParseableDate(updated) &&
    Date.parse(created) > Date.parse(updated)
  ) {
    out['updated'] = created;
  }

  if (typeof raw['summary'] === 'string') {
    out['summary'] = raw['summary'];
  }

  if (raw['source'] !== undefined && raw['source'] !== null) {
    out['source'] = SOURCE_VALUES.includes(raw['source'] as SourceValue)
      ? (raw['source'] as SourceValue)
      : 'unknown';
  }

  return out as unknown as Frontmatter;
}
