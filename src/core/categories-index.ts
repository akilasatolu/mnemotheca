// src/core/categories-index.ts — `vault/categories/*.md` の原子的再生成(設計書 §8-J / §4-1 / §10-2 末尾)。
//
// `knowledge/` 側のディレクトリツリー(= `listNotes` の結果の `categories[0]`)を正として
// `vault/categories/<path>.md` をミラー生成する。categories/ は派生物であり、ここで丸ごと
// 作り直せる。表示名(frontmatter `title`)だけはユーザー/organize が書き換えた値を正として
// 保持する(§8-J「表示名管理の確定」)。
//
// 原子性: 新しい categories/ ツリーを vault 内の一時ディレクトリ(`.categories.tmp-<rand>`)に
// 丸ごと組み立ててから、既存 categories/ と入れ替える。組み立て中に失敗しても既存 categories/ は
// 無傷(部分状態が Obsidian / UI に見えない)。

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { listNotes, type NoteRef } from './note.js';
import { vaultPaths } from './paths.js';

/** `regenerateCategories` の戻り値(設計書 §8-J)。 */
export interface RegenerateCategoriesResult {
  /** 生成した `categories/*.md` の件数(親カテゴリ・`_uncategorized` を含む)。 */
  written: number;
  /** 再生成前に存在したが今回対応が無くなり削除された `categories/*.md` の件数。 */
  removed: number;
}

/** 1 カテゴリ(= `knowledge/` 相対のセグメント経路)に集約したノート群。 */
interface CategoryBucket {
  /** POSIX 区切りのカテゴリ経路(例: `architecture` / `tech/architecture` / `_uncategorized`)。 */
  catPath: string;
  /** このカテゴリ(`categories[0]` が完全一致)に属するノート。親カテゴリのみの場合は空。 */
  notes: NoteRef[];
}

const TITLE_LIST_HEADING = '# ';

/** `categories[0]` として妥当な文字列か(非空・`..` / 先頭スラッシュを含まない)。 */
function isUsableCategoryPath(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const v = value.trim();
  if (v === '' || v.startsWith('/')) {
    return false;
  }
  return !v.split('/').some((seg) => seg === '' || seg === '..' || seg === '.');
}

/** `<catPath>` とその全祖先セグメント経路を返す(`tech/architecture` → `['tech', 'tech/architecture']`)。 */
function pathWithAncestors(catPath: string): string[] {
  const segs = catPath.split('/');
  const out: string[] = [];
  for (let i = 0; i < segs.length; i += 1) {
    out.push(segs.slice(0, i + 1).join('/'));
  }
  return out;
}

/**
 * 既存 `categories/**\/*.md` を再帰列挙する。
 * - `titles`: `<catPath>` → frontmatter `title`(非空のもののみ)
 * - `paths`: 存在した全 `<catPath>` の集合(削除件数の算出に使う)
 */
async function readExisting(
  categoriesDir: string,
): Promise<{ titles: Map<string, string>; paths: Set<string> }> {
  const titles = new Map<string, string>();
  const paths = new Set<string>();

  async function walk(dir: string, relBase: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw err;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue;
      }
      const full = path.join(dir, entry.name);
      const rel = relBase === '' ? entry.name : `${relBase}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(full, rel);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const catPath = rel.slice(0, -'.md'.length);
        paths.add(catPath);
        try {
          const parsed = matter(await fs.promises.readFile(full, 'utf8'));
          const t = (parsed.data as Record<string, unknown>)['title'];
          if (typeof t === 'string' && t.trim() !== '') {
            titles.set(catPath, t);
          }
        } catch {
          // 壊れた既存カテゴリファイルの title は諦めてセグメント名にフォールバックする。
        }
      }
    }
  }

  await walk(categoriesDir, '');
  return { titles, paths };
}

/** カテゴリファイル 1 枚の Markdown 文字列を組み立てる。 */
function buildCategoryFile(
  catPath: string,
  notes: NoteRef[],
  title: string,
): string {
  const segs = catPath.split('/');
  // このカテゴリファイルが置かれるディレクトリの vault ルート相対(POSIX)。
  const fileDirRel = ['categories', ...segs.slice(0, -1)].join('/');

  const sorted = [...notes].sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

  const lines = sorted.map((n) => {
    const link = path.posix.relative(fileDirRel, n.relPath);
    const noteTitle = typeof n.fm.title === 'string' && n.fm.title.trim() !== ''
      ? n.fm.title
      : path.basename(n.relPath, '.md');
    const summary = typeof n.fm.summary === 'string' ? n.fm.summary.trim() : '';
    return summary === ''
      ? `- [${noteTitle}](${link})`
      : `- [${noteTitle}](${link}) — ${summary}`;
  });

  // `updated`: メンバーノートの最新 `updated`。ノートが無ければ現在時刻。
  let updated = '';
  for (const n of sorted) {
    const u = typeof n.fm.updated === 'string' ? n.fm.updated : '';
    if (u > updated) {
      updated = u;
    }
  }
  if (updated === '') {
    updated = new Date().toISOString();
  }

  const body = `${TITLE_LIST_HEADING}${title}\n\n${
    lines.length > 0 ? `${lines.join('\n')}\n` : ''
  }`;

  return matter.stringify(body, { title, count: notes.length, updated });
}

/**
 * `vault/categories/*.md` を `knowledge/` 構造から原子的に再生成する(設計書 §8-J)。
 *
 * - `listNotes` の各ノートを `categories[0]` のセグメント経路ごとに集約する。
 * - 多階層カテゴリ(`tech/architecture`)は親(`categories/tech.md`)も生成する。
 * - `_uncategorized` も常に 1 カテゴリとして生成する。
 * - frontmatter は `{ title, count, updated }`。`title` は既存 `categories/<path>.md` の
 *   値を保持し、新規カテゴリはセグメント名を使う。
 * - 本文はノート一覧(`- [title](<相対リンク>) — summary`)。
 * - `knowledge/` に対応しなくなった `categories/*.md` は結果から消える(ツリーごと差し替え)。
 * - `.categories.tmp-<rand>` に新ツリーを組み立ててから既存 `categories/` と入れ替える。
 */
export async function regenerateCategories(
  projectRoot: string,
): Promise<RegenerateCategoriesResult> {
  const { root: vaultRoot, categoriesDir } = vaultPaths(projectRoot);

  const { notes } = await listNotes(projectRoot);
  const { titles: existingTitles, paths: existingPaths } = await readExisting(categoriesDir);

  // 1. カテゴリ経路ごとにノートを集約。
  const buckets = new Map<string, CategoryBucket>();
  const ensureBucket = (catPath: string): CategoryBucket => {
    let b = buckets.get(catPath);
    if (b === undefined) {
      b = { catPath, notes: [] };
      buckets.set(catPath, b);
    }
    return b;
  };

  // `_uncategorized` は常に 1 カテゴリとして存在させる。
  ensureBucket('_uncategorized');

  for (const note of notes) {
    const cat0 = note.fm.categories?.[0];
    if (!isUsableCategoryPath(cat0)) {
      continue;
    }
    const catPath = cat0.trim();
    // 祖先カテゴリ(親ディレクトリ)にも空バケツを用意する。
    for (const ancestor of pathWithAncestors(catPath)) {
      ensureBucket(ancestor);
    }
    ensureBucket(catPath).notes.push(note);
  }

  // 2. 一時ディレクトリに新しい categories/ ツリーを丸ごと組み立てる。
  const tmpDir = path.join(vaultRoot, `.categories.tmp-${randomBytes(6).toString('hex')}`);
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
  await fs.promises.mkdir(tmpDir, { recursive: true });

  let written = 0;
  const newPaths = new Set<string>();
  try {
    for (const bucket of buckets.values()) {
      const segs = bucket.catPath.split('/');
      const title = existingTitles.get(bucket.catPath) ?? segs[segs.length - 1] ?? bucket.catPath;
      const outPath = `${path.join(tmpDir, ...segs)}.md`;
      await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
      await fs.promises.writeFile(outPath, buildCategoryFile(bucket.catPath, bucket.notes, title), 'utf8');
      newPaths.add(bucket.catPath);
      written += 1;
    }
  } catch (err) {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {
      /* 掃除失敗は致命的でない */
    });
    throw err;
  }

  // 3. 原子的に差し替える。
  //    rename が失敗しても、この時点までは既存 categories/ が無傷であること(§13-2b 原子性)。
  const trashDir = path.join(vaultRoot, `.categories.old-${randomBytes(6).toString('hex')}`);
  let hadExisting = false;
  try {
    try {
      await fs.promises.rename(categoriesDir, trashDir);
      hadExisting = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }
    await fs.promises.rename(tmpDir, categoriesDir);
  } catch (err) {
    // 差し替えに失敗した: 退避済みの旧 categories/ を戻し、tmp を掃除する。
    if (hadExisting && !fs.existsSync(categoriesDir)) {
      await fs.promises.rename(trashDir, categoriesDir).catch(() => {
        /* ロールバック失敗はこれ以上どうにもできない */
      });
    }
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  await fs.promises.rm(trashDir, { recursive: true, force: true }).catch(() => {
    /* 旧ツリーの掃除失敗は致命的でない */
  });

  let removed = 0;
  for (const p of existingPaths) {
    if (!newPaths.has(p)) {
      removed += 1;
    }
  }
  return { written, removed };
}
