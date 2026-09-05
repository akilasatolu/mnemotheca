import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { regenerateCategories } from '../../src/core/categories-index.js';
import type { Frontmatter } from '../../src/core/frontmatter.js';
import { writeNote } from '../../src/core/note.js';
import { vaultPaths } from '../../src/core/paths.js';
import { makeProject } from '../helpers/project.js';

const roots: string[] = [];

async function mkProject(): Promise<string> {
  const root = await makeProject();
  roots.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length > 0) {
    const d = roots.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

function fm(overrides: Partial<Frontmatter> = {}): Frontmatter {
  return {
    id: '20260901T093015123k7f2a',
    title: 'あるノート',
    categories: ['architecture'],
    tags: [],
    created: '2026-09-01T09:30:15+09:00',
    updated: '2026-09-01T09:30:15+09:00',
    summary: '要約テキスト',
    ...overrides,
  };
}

const BODY = '## 要約\n\n要約本文\n\n## 詳細\n\n詳細本文\n';

function knowledgePath(root: string, ...segs: string[]): string {
  return path.join(vaultPaths(root).knowledgeDir, ...segs);
}
function catFile(root: string, ...segs: string[]): string {
  return path.join(vaultPaths(root).categoriesDir, ...segs);
}
function readCat(root: string, ...segs: string[]): matter.GrayMatterFile<string> {
  return matter(fs.readFileSync(catFile(root, ...segs), 'utf8'));
}

async function seed(root: string, cat: string, slug: string, over: Partial<Frontmatter> = {}): Promise<void> {
  await writeNote(
    knowledgePath(root, ...cat.split('/'), `${slug}.md`),
    fm({ id: `${cat}-${slug}`, categories: [cat], title: `${slug} の見出し`, summary: `${slug} の要約`, ...over }),
    BODY,
  );
}

// ---------------------------------------------------------------------------
// 正常系: 3 カテゴリ・各 2 ノート → ミラー生成
// ---------------------------------------------------------------------------

describe('regenerateCategories() — mirrors knowledge structure', () => {
  it('generates categories/<cat>.md with count and note-list links', async () => {
    const root = await mkProject();
    for (const c of ['a', 'b', 'c']) {
      await seed(root, c, 'one');
      await seed(root, c, 'two');
    }

    const res = await regenerateCategories(root);

    for (const c of ['a', 'b', 'c']) {
      const f = readCat(root, `${c}.md`);
      expect(f.data['count']).toBe(2);
      expect(f.data['title']).toBe(c);
      // js-yaml はタイムスタンプ様の値を Date にパースしうる(note frontmatter と同じ挙動)。
      expect(f.data['updated'] instanceof Date || typeof f.data['updated'] === 'string').toBe(true);
      expect(f.content).toContain(`- [one の見出し](../knowledge/${c}/one.md) — one の要約`);
      expect(f.content).toContain(`- [two の見出し](../knowledge/${c}/two.md) — two の要約`);
    }
    // a, b, c + _uncategorized
    expect(res.written).toBe(4);
    expect(res.removed).toBe(0);
  });

  it('always generates categories/_uncategorized.md as one category', async () => {
    const root = await mkProject();
    await seed(root, 'architecture', 'x');
    await seed(root, '_uncategorized', 'loose');

    await regenerateCategories(root);

    const f = readCat(root, '_uncategorized.md');
    expect(f.data['title']).toBe('_uncategorized');
    expect(f.data['count']).toBe(1);
    expect(f.content).toContain('- [loose の見出し](../knowledge/_uncategorized/loose.md) — loose の要約');
  });

  it('generates _uncategorized.md even when there are no uncategorized notes', async () => {
    const root = await mkProject();
    await seed(root, 'architecture', 'x');

    await regenerateCategories(root);

    expect(fs.existsSync(catFile(root, '_uncategorized.md'))).toBe(true);
    expect(readCat(root, '_uncategorized.md').data['count']).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 表示名: 既存 title 保持 / 新規はセグメント名
// ---------------------------------------------------------------------------

describe('regenerateCategories() — display-name (title) management', () => {
  it('keeps an existing categories/<cat>.md title and uses the segment name for new categories', async () => {
    const root = await mkProject();
    await seed(root, 'architecture', 'x');

    // 1 回目 → title はセグメント名 "architecture"
    await regenerateCategories(root);
    expect(readCat(root, 'architecture.md').data['title']).toBe('architecture');

    // ユーザー / organize が title を書き換える
    const p = catFile(root, 'architecture.md');
    const cur = matter(fs.readFileSync(p, 'utf8'));
    fs.writeFileSync(p, matter.stringify(cur.content, { ...cur.data, title: '設計' }));

    // 新カテゴリを足して再生成
    await seed(root, 'ops', 'y');
    await regenerateCategories(root);

    expect(readCat(root, 'architecture.md').data['title']).toBe('設計'); // 保持
    expect(readCat(root, 'ops.md').data['title']).toBe('ops'); // 新規はセグメント名
  });
});

// ---------------------------------------------------------------------------
// 孤児削除
// ---------------------------------------------------------------------------

describe('regenerateCategories() — orphan removal', () => {
  it('drops categories/*.md whose knowledge directory no longer has notes', async () => {
    const root = await mkProject();
    await seed(root, 'keep', 'a');
    await seed(root, 'old', 'b');
    await regenerateCategories(root);
    expect(fs.existsSync(catFile(root, 'old.md'))).toBe(true);

    // old カテゴリのノートを全部消す
    fs.rmSync(knowledgePath(root, 'old'), { recursive: true, force: true });
    const res = await regenerateCategories(root);

    expect(fs.existsSync(catFile(root, 'old.md'))).toBe(false);
    expect(fs.existsSync(catFile(root, 'keep.md'))).toBe(true);
    expect(res.removed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 多階層カテゴリのミラー
// ---------------------------------------------------------------------------

describe('regenerateCategories() — multi-level categories', () => {
  it('mirrors tech/architecture to categories/tech/architecture.md and also generates parent categories/tech.md', async () => {
    const root = await mkProject();
    await seed(root, 'tech/architecture', 'adr');

    await regenerateCategories(root);

    expect(fs.existsSync(catFile(root, 'tech', 'architecture.md'))).toBe(true);
    expect(fs.existsSync(catFile(root, 'tech.md'))).toBe(true);

    const leaf = readCat(root, 'tech', 'architecture.md');
    expect(leaf.data['title']).toBe('architecture');
    expect(leaf.data['count']).toBe(1);
    // categories/tech/ からの相対リンク
    expect(leaf.content).toContain('- [adr の見出し](../../knowledge/tech/architecture/adr.md) — adr の要約');

    const parent = readCat(root, 'tech.md');
    expect(parent.data['title']).toBe('tech');
    expect(parent.data['count']).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 原子性: 生成途中で失敗しても旧 categories/ が壊れない
// ---------------------------------------------------------------------------

describe('regenerateCategories() — atomic swap', () => {
  it('leaves the existing categories/ intact when building the new tree fails before the swap', async () => {
    const root = await mkProject();
    await seed(root, 'architecture', 'x');
    await regenerateCategories(root);
    const before = fs.readFileSync(catFile(root, 'architecture.md'), 'utf8');

    // tmp ツリーへの書き込み中にクラッシュを模擬
    const spy = vi
      .spyOn(fs.promises, 'writeFile')
      .mockRejectedValueOnce(new Error('simulated crash while building tmp tree'));

    await expect(regenerateCategories(root)).rejects.toThrow('simulated crash while building tmp tree');
    expect(spy).toHaveBeenCalled();

    // 既存 categories/ は無傷
    expect(fs.readFileSync(catFile(root, 'architecture.md'), 'utf8')).toBe(before);
    // 一時ディレクトリの残骸が無い
    const leftovers = fs.readdirSync(vaultPaths(root).root).filter((n) => n.startsWith('.categories.'));
    expect(leftovers).toEqual([]);
  });

  it('leaves the existing categories/ intact when the rename swap fails', async () => {
    const root = await mkProject();
    await seed(root, 'architecture', 'x');
    await regenerateCategories(root);
    const before = fs.readFileSync(catFile(root, 'architecture.md'), 'utf8');

    const spy = vi
      .spyOn(fs.promises, 'rename')
      .mockRejectedValueOnce(new Error('simulated crash during swap'));

    await expect(regenerateCategories(root)).rejects.toThrow('simulated crash during swap');
    expect(spy).toHaveBeenCalled();

    expect(fs.readFileSync(catFile(root, 'architecture.md'), 'utf8')).toBe(before);
    const leftovers = fs.readdirSync(vaultPaths(root).root).filter((n) => n.startsWith('.categories.'));
    expect(leftovers).toEqual([]);
  });

  it('replaces the whole tree (no stale partial state) on a normal run', async () => {
    const root = await mkProject();
    await seed(root, 'architecture', 'x');
    await regenerateCategories(root);

    // categories/ に手で余計なファイルを置く → 次の再生成で消える(ツリーごと差し替え)
    fs.writeFileSync(catFile(root, 'stale-manual.md'), '---\ntitle: junk\n---\n\n# junk\n');
    await regenerateCategories(root);

    expect(fs.existsSync(catFile(root, 'stale-manual.md'))).toBe(false);
    expect(fs.existsSync(catFile(root, 'architecture.md'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 境界: ノート無し
// ---------------------------------------------------------------------------

describe('regenerateCategories() — empty vault', () => {
  it('generates only _uncategorized.md when there are no notes', async () => {
    const root = await mkProject();
    const res = await regenerateCategories(root);

    expect(res.written).toBe(1);
    expect(fs.readdirSync(vaultPaths(root).categoriesDir)).toEqual(['_uncategorized.md']);
    expect(readCat(root, '_uncategorized.md').data['count']).toBe(0);
  });
});
