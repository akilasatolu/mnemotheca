// src/server/routes/categories.ts — `GET /api/categories`(設計 §10-1 エンドポイント表 / DTO / §4 / §13-13)。
//
// 責務(薄いルート):
//   - `knowledge/` 配下の実ディレクトリ構造(= `listNotes` の各ノートの vault 相対パス)を
//     正としてカテゴリツリー(`CategoryNode[]`)を組み立てる。
//   - 各ノードの `title` は `vault/categories/<path>.md` の frontmatter `title`。無ければ
//     末尾セグメント名にフォールバック(設計 §4「表示名は categories/<path>.md の title」)。
//   - `noteCount` は「そのカテゴリ経路に直接属するノート数」(子孫は含めない。§13-11b と同基準)。
//   - `_uncategorized`(空カテゴリ経路含む)はツリーに含めず `uncategorizedCount` で別カウント。
//
// 結線は `src/server/mount.ts` の `mountApiRoutes` が `api.route('/categories', createCategoriesRoutes(deps))` で行う。
//
// 規約: ESM / NodeNext / strict / verbatimModuleSyntax / noUncheckedIndexedAccess。

import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { Hono } from 'hono';
import { listNotes } from '../../core/note.js';
import { vaultPaths } from '../../core/paths.js';

/** `createCategoriesRoutes` の依存。 */
export interface CategoriesRoutesDeps {
  /** projectRoot 絶対パス。 */
  projectRoot: string;
}

/** §10-1 DTO。`CategoryNode`。 */
export interface CategoryNode {
  /** `knowledge/` 相対の POSIX カテゴリ経路(例: `tech/architecture`)。 */
  path: string;
  /** 末尾セグメント名。 */
  name: string;
  /** 表示名(`categories/<path>.md` の `title`、無ければ `name`)。 */
  title: string;
  /** この経路に直接属するノート数(子孫は含めない)。 */
  noteCount: number;
  children: CategoryNode[];
}

interface CategoriesResponse {
  tree: CategoryNode[];
  uncategorizedCount: number;
}

/** ノートの vault 相対パス(`knowledge/<...>/<slug>.md`)→ `knowledge/` 相対のカテゴリ経路。 */
function categoryPathOf(relPath: string): string {
  return relPath.split('/').slice(1, -1).join('/');
}

/** `<catPath>` とその全祖先経路(`tech/arch` → `['tech', 'tech/arch']`)。 */
function pathWithAncestors(catPath: string): string[] {
  const segs = catPath.split('/');
  return segs.map((_, i) => segs.slice(0, i + 1).join('/'));
}

/** `vault/categories/<catPath>.md` の frontmatter `title`。無ければセグメント名にフォールバック。 */
async function resolveTitle(categoriesDir: string, catPath: string): Promise<string> {
  const segs = catPath.split('/');
  const fallback = segs[segs.length - 1] ?? catPath;
  const file = `${path.join(categoriesDir, ...segs)}.md`;
  let raw: string;
  try {
    raw = await fs.promises.readFile(file, 'utf8');
  } catch {
    return fallback;
  }
  try {
    const t = (matter(raw).data as Record<string, unknown>)['title'];
    return typeof t === 'string' && t.trim() !== '' ? t : fallback;
  } catch {
    return fallback;
  }
}

export function createCategoriesRoutes(deps: CategoriesRoutesDeps): Hono {
  const r = new Hono();
  const { categoriesDir } = vaultPaths(deps.projectRoot);

  r.get('/', async (c) => {
    const { notes } = await listNotes(deps.projectRoot);

    const directCount = new Map<string, number>();
    const allPaths = new Set<string>();
    let uncategorizedCount = 0;

    for (const note of notes) {
      const catPath = categoryPathOf(note.relPath);
      if (catPath === '' || catPath === '_uncategorized') {
        uncategorizedCount += 1;
        continue;
      }
      directCount.set(catPath, (directCount.get(catPath) ?? 0) + 1);
      for (const ancestor of pathWithAncestors(catPath)) allPaths.add(ancestor);
    }

    // 経路集合からツリーを構築する。
    const nodes = new Map<string, CategoryNode>();
    const sortedPaths = [...allPaths].sort((a, b) => a.localeCompare(b));
    for (const p of sortedPaths) {
      const segs = p.split('/');
      nodes.set(p, {
        path: p,
        name: segs[segs.length - 1] ?? p,
        title: await resolveTitle(categoriesDir, p),
        noteCount: directCount.get(p) ?? 0,
        children: [],
      });
    }

    const roots: CategoryNode[] = [];
    for (const p of sortedPaths) {
      const node = nodes.get(p);
      if (node === undefined) continue;
      const segs = p.split('/');
      if (segs.length === 1) {
        roots.push(node);
      } else {
        const parent = nodes.get(segs.slice(0, -1).join('/'));
        (parent?.children ?? roots).push(node);
      }
    }

    const body: CategoriesResponse = { tree: roots, uncategorizedCount };
    return c.json(body);
  });

  return r;
}

export default createCategoriesRoutes;
