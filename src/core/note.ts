// src/core/note.ts — 1 ノートの読み込み・書き込み・本文テンプレート組み立て(設計書 §8-D / §10-2-5)。
//
// frontmatter の parse / serialize は core/frontmatter.ts に委譲し、このモジュールは
// ファイル I/O(原子的書き込み・再帰列挙)と本文テンプレートに責務を限定する。
// パスの組み立ては core/paths.ts(`vaultPaths`)に集約する。

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isMnemoError } from './errors.js';
import type { Frontmatter, ParsedNote } from './frontmatter.js';
import { parseNote, serializeNote } from './frontmatter.js';
import { vaultPaths } from './paths.js';

/** 正常に読めた 1 ノートの参照(設計書 §8-D)。 */
export interface NoteRef {
  /** frontmatter の `id`。 */
  id: string;
  /** 絶対パス。 */
  absPath: string;
  /** vault ルート相対・POSIX 区切り(`knowledge/...`)。 */
  relPath: string;
  /** パース済み frontmatter。 */
  fm: Frontmatter;
}

/** パースに失敗したノートの記録(設計書 §8-D / §12-4)。 */
export interface NoteError {
  /** vault ルート相対・POSIX 区切り(`knowledge/...`)。 */
  relPath: string;
  /** `MnemoError.code`(通常は `FRONTMATTER_PARSE` / `FRONTMATTER_SCHEMA`)。 */
  code: string;
  /** 人間可読なエラーメッセージ。 */
  message: string;
}

/** 1 ノートを読み込み frontmatter と本文へ分解する(設計書 §8-D)。 */
export async function readNote(absPath: string): Promise<ParsedNote> {
  const raw = await fs.promises.readFile(absPath, 'utf8');
  return parseNote(raw);
}

/**
 * frontmatter + 本文を Markdown ファイルへ原子的に書き込む(設計書 §8-D)。
 * - 親ディレクトリは `mkdir -p`。
 * - 同ディレクトリの `.<name>.tmp-<rand>` に書いて `rename` で差し替える。
 * - `rename` 前に失敗しても元ファイルは無傷。tmp は finally で必ず掃除する。
 */
export async function writeNote(absPath: string, fm: Frontmatter, body: string): Promise<void> {
  const dir = path.dirname(absPath);
  await fs.promises.mkdir(dir, { recursive: true });

  const tmpPath = path.join(dir, `.${path.basename(absPath)}.tmp-${randomBytes(6).toString('hex')}`);
  const content = serializeNote(fm, body);

  try {
    await fs.promises.writeFile(tmpPath, content, 'utf8');
    await fs.promises.rename(tmpPath, absPath);
  } finally {
    // rename 成功後は tmp が存在しないので force で ENOENT を握りつぶす。
    await fs.promises.rm(tmpPath, { force: true }).catch(() => {
      /* 掃除失敗は致命的でない */
    });
  }
}

/** `buildBody` の入力セクション(設計書 §10-2-5)。 */
export interface BodySections {
  /** `## 要約` セクション本文。 */
  summary: string;
  /** `## 詳細` セクション本文。 */
  detail: string;
  /** `## 出典・参考` セクション本文。空 / 未指定なら節自体を出力しない。 */
  refs?: string;
}

/**
 * 本文テンプレートを組み立てる(設計書 §10-2-5)。
 * `## 要約` / `## 詳細` は常時出力。`## 出典・参考` は `refs` が非空のときのみ。
 */
export function buildBody(sections: BodySections): string {
  const parts: string[] = [
    `## 要約\n\n${sections.summary}`,
    `## 詳細\n\n${sections.detail}`,
  ];
  if (sections.refs !== undefined && sections.refs.trim() !== '') {
    parts.push(`## 出典・参考\n\n${sections.refs}`);
  }
  return `${parts.join('\n\n')}\n`;
}

/** 絶対パスを vault ルート相対・POSIX 区切りへ変換する(設計書 §8-D)。 */
export function noteRelPath(projectRoot: string, absPath: string): string {
  const vaultRoot = vaultPaths(projectRoot).root;
  return path.relative(vaultRoot, absPath).split(path.sep).join('/');
}

/**
 * カテゴリ経路 + slug から knowledge 配下の絶対パスを組み立てる(設計書 §8-D)。
 * `categorySegOrPath` は単一セグメント(`architecture`)でも多階層(`tech/arch`)でも可。
 */
export function noteAbsPathForCategory(
  projectRoot: string,
  categorySegOrPath: string,
  slug: string,
): string {
  const { knowledgeDir } = vaultPaths(projectRoot);
  const segments = categorySegOrPath.split(/[/\\]/).filter((s) => s !== '');
  return path.join(knowledgeDir, ...segments, `${slug}.md`);
}

/** ドット始まりでないディレクトリを再帰し、`.md` ファイルの絶対パスを集める。 */
async function walkMarkdown(dir: string): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw err;
  }

  const found: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) {
      continue; // ドット要素(ディレクトリ・ファイルとも)は除外
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await walkMarkdown(full)));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      found.push(full);
    }
  }
  return found;
}

/**
 * `vault/knowledge/**\/*.md` を再帰列挙する(設計書 §8-D / §12-4)。
 * - `_uncategorized` は 1 カテゴリとして含む。`vault/categories/` とドット要素は対象外
 *   (`knowledgeDir` 配下しか走査しないので `categories/` は構造的に除外される)。
 * - 壊れたノート(`parseNote` が投げる)は `errors[]` に積み、残りは `notes[]` に入れて継続。
 */
export async function listNotes(
  projectRoot: string,
): Promise<{ notes: NoteRef[]; errors: NoteError[] }> {
  const { knowledgeDir } = vaultPaths(projectRoot);
  const files = (await walkMarkdown(knowledgeDir)).sort();

  const notes: NoteRef[] = [];
  const errors: NoteError[] = [];

  for (const absPath of files) {
    const relPath = noteRelPath(projectRoot, absPath);
    try {
      const raw = await fs.promises.readFile(absPath, 'utf8');
      const parsed = parseNote(raw);
      notes.push({ id: parsed.fm.id, absPath, relPath, fm: parsed.fm });
    } catch (err) {
      errors.push({
        relPath,
        code: isMnemoError(err) ? err.code : 'READ_ERROR',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { notes, errors };
}
