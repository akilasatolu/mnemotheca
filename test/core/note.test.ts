import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isMnemoError } from '../../src/core/errors.js';
import type { Frontmatter } from '../../src/core/frontmatter.js';
import { parseNote } from '../../src/core/frontmatter.js';
import {
  buildBody,
  listNotes,
  noteAbsPathForCategory,
  noteRelPath,
  readNote,
  writeNote,
} from '../../src/core/note.js';
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

function fullFm(overrides: Partial<Frontmatter> = {}): Frontmatter {
  return {
    id: '20260901T093015123k7f2a',
    title: 'AWS 上での MCP ナレッジ保管フィージビリティ',
    categories: ['architecture'],
    tags: ['aws', 'mcp', 'bedrock'],
    created: '2026-09-01T09:30:15+09:00',
    updated: '2026-09-01T09:30:15+09:00',
    summary: 'AWS 上で MCP ベースのナレッジ保管を実装する場合の構成と制約を整理。',
    source: 'claude-desktop',
    ...overrides,
  };
}

const BODY = '## 要約\n\n要約本文\n\n## 詳細\n\n詳細本文\n';

/** knowledge/<cat>/<slug>.md の絶対パス。 */
function knowledgePath(root: string, ...segs: string[]): string {
  return path.join(vaultPaths(root).knowledgeDir, ...segs);
}

// ---------------------------------------------------------------------------
// buildBody(§10-2-5 / §13-6b)
// ---------------------------------------------------------------------------

describe('buildBody()', () => {
  it('always emits ## 要約 and ## 詳細', () => {
    const out = buildBody({ summary: 'S 本文', detail: 'D 本文' });
    expect(out).toContain('## 要約\n\nS 本文');
    expect(out).toContain('## 詳細\n\nD 本文');
    expect(out).not.toContain('## 出典・参考');
    expect(out.endsWith('\n')).toBe(true);
  });

  it('emits ## 出典・参考 only when refs is non-empty', () => {
    const withRefs = buildBody({ summary: 'S', detail: 'D', refs: '- https://example.com' });
    expect(withRefs).toContain('## 出典・参考\n\n- https://example.com');

    expect(buildBody({ summary: 'S', detail: 'D', refs: '' })).not.toContain('## 出典・参考');
    expect(buildBody({ summary: 'S', detail: 'D', refs: '   ' })).not.toContain('## 出典・参考');
    expect(buildBody({ summary: 'S', detail: 'D', refs: undefined })).not.toContain('## 出典・参考');
  });

  it('orders sections 要約 → 詳細 → 出典・参考', () => {
    const out = buildBody({ summary: 'S', detail: 'D', refs: 'R' });
    expect(out.indexOf('## 要約')).toBeLessThan(out.indexOf('## 詳細'));
    expect(out.indexOf('## 詳細')).toBeLessThan(out.indexOf('## 出典・参考'));
  });
});

// ---------------------------------------------------------------------------
// noteRelPath / noteAbsPathForCategory
// ---------------------------------------------------------------------------

describe('noteRelPath()', () => {
  it('returns a vault-root-relative POSIX path', async () => {
    const root = await mkProject();
    const abs = knowledgePath(root, 'architecture', 'aws-mcp.md');
    expect(noteRelPath(root, abs)).toBe('knowledge/architecture/aws-mcp.md');
  });
});

describe('noteAbsPathForCategory()', () => {
  it('joins single-segment and multi-segment categories under knowledgeDir', async () => {
    const root = await mkProject();
    expect(noteAbsPathForCategory(root, 'architecture', 'aws-mcp')).toBe(
      knowledgePath(root, 'architecture', 'aws-mcp.md'),
    );
    expect(noteAbsPathForCategory(root, 'tech/arch', 'aws-mcp')).toBe(
      knowledgePath(root, 'tech', 'arch', 'aws-mcp.md'),
    );
  });
});

// ---------------------------------------------------------------------------
// writeNote / readNote(§13-6b note)
// ---------------------------------------------------------------------------

describe('writeNote()', () => {
  it('creates missing parent directories (mkdir -p)', async () => {
    const root = await mkProject();
    const abs = knowledgePath(root, 'deeply', 'nested', 'new-cat', 'note.md');
    expect(fs.existsSync(path.dirname(abs))).toBe(false);

    await writeNote(abs, fullFm({ categories: ['deeply/nested/new-cat'] }), BODY);

    expect(fs.existsSync(abs)).toBe(true);
    const parsed = parseNote(fs.readFileSync(abs, 'utf8'));
    expect(parsed.fm.id).toBe('20260901T093015123k7f2a');
  });

  it('is atomic: a throw before rename leaves the original intact and no tmp file behind', async () => {
    const root = await mkProject();
    const abs = knowledgePath(root, 'architecture', 'note.md');

    // 既存ノートを普通に書く。
    await writeNote(abs, fullFm({ title: '元のタイトル' }), BODY);
    const before = fs.readFileSync(abs, 'utf8');

    // rename を rename 前 throw に差し替え(= プロセス kill 相当)。
    const spy = vi
      .spyOn(fs.promises, 'rename')
      .mockRejectedValueOnce(new Error('simulated crash before rename'));

    await expect(
      writeNote(abs, fullFm({ title: '新しいタイトル(書かれてはいけない)' }), BODY),
    ).rejects.toThrow('simulated crash before rename');

    expect(spy).toHaveBeenCalledTimes(1);
    // 元ファイルは無傷。
    expect(fs.readFileSync(abs, 'utf8')).toBe(before);
    // .<name>.tmp-<rand> が残っていない。
    const leftovers = fs
      .readdirSync(path.dirname(abs))
      .filter((n) => n.startsWith('.') && n.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('round-trips frontmatter key order and body via readNote → writeNote → readNote', async () => {
    const root = await mkProject();
    const src = knowledgePath(root, 'architecture', 'src.md');
    await writeNote(src, fullFm(), BODY);

    const first = await readNote(src);

    const dst = knowledgePath(root, 'architecture', 'dst.md');
    await writeNote(dst, first.fm, first.body);
    const second = await readNote(dst);

    expect(second.fm).toEqual(first.fm);
    expect(second.body).toBe(first.body);

    // YAML キー順が §10-2 固定順(id → title → categories → tags → created → updated → summary → source)。
    const rawDst = fs.readFileSync(dst, 'utf8');
    const order = ['id:', 'title:', 'categories:', 'tags:', 'created:', 'updated:', 'summary:', 'source:'].map(
      (k) => rawDst.indexOf(`\n${k}`) >= 0 ? rawDst.indexOf(`\n${k}`) : rawDst.indexOf(k),
    );
    const sorted = [...order].sort((a, b) => a - b);
    expect(order).toEqual(sorted);
  });
});

describe('readNote()', () => {
  it('throws MnemoError(FRONTMATTER_PARSE) on a note without frontmatter', async () => {
    const root = await mkProject();
    const abs = knowledgePath(root, 'architecture', 'no-fm.md');
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, '# just a heading\n', 'utf8');

    const err = await readNote(abs).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(isMnemoError(err) && err.code === 'FRONTMATTER_PARSE').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// listNotes(§13-6b note)
// ---------------------------------------------------------------------------

describe('listNotes()', () => {
  it('returns empty when knowledgeDir has no notes', async () => {
    const root = await mkProject();
    const { notes, errors } = await listNotes(root);
    expect(notes).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('recursively enumerates knowledge/**/*.md, includes _uncategorized, excludes dot elements', async () => {
    const root = await mkProject();

    await writeNote(knowledgePath(root, 'architecture', 'a.md'), fullFm({ id: 'ID-A', categories: ['architecture'] }), BODY);
    await writeNote(
      knowledgePath(root, 'architecture', 'deep', 'b.md'),
      fullFm({ id: 'ID-B', categories: ['architecture/deep'] }),
      BODY,
    );
    await writeNote(
      knowledgePath(root, '_uncategorized', 'c.md'),
      fullFm({ id: 'ID-C', categories: ['_uncategorized'] }),
      BODY,
    );

    // 除外されるべきもの: categories/ 配下、ドットディレクトリ、ドットファイル、非 .md。
    await fs.promises.mkdir(vaultPaths(root).categoriesDir, { recursive: true });
    await fs.promises.writeFile(path.join(vaultPaths(root).categoriesDir, 'architecture.md'), '# cat\n');
    await fs.promises.mkdir(knowledgePath(root, '.obsidian'), { recursive: true });
    await fs.promises.writeFile(knowledgePath(root, '.obsidian', 'x.md'), 'noise');
    await fs.promises.writeFile(knowledgePath(root, 'architecture', '.hidden.md'), 'noise');
    await fs.promises.writeFile(knowledgePath(root, 'architecture', 'notes.txt'), 'noise');

    const { notes, errors } = await listNotes(root);
    expect(errors).toEqual([]);
    expect(notes.map((n) => n.id).sort()).toEqual(['ID-A', 'ID-B', 'ID-C']);
    expect(notes.map((n) => n.relPath).sort()).toEqual([
      'knowledge/_uncategorized/c.md',
      'knowledge/architecture/a.md',
      'knowledge/architecture/deep/b.md',
    ]);
    for (const n of notes) {
      expect(path.isAbsolute(n.absPath)).toBe(true);
      expect(n.fm.id).toBe(n.id);
    }
  });

  it('collects a broken note into errors[] and keeps the rest in notes[]', async () => {
    const root = await mkProject();
    await writeNote(knowledgePath(root, 'architecture', 'ok.md'), fullFm({ id: 'ID-OK' }), BODY);

    const broken = knowledgePath(root, 'architecture', 'broken.md');
    await fs.promises.mkdir(path.dirname(broken), { recursive: true });
    await fs.promises.writeFile(broken, '---\nid: "unterminated\ntitle: x\n---\n\nbody\n', 'utf8');

    const { notes, errors } = await listNotes(root);
    expect(notes.map((n) => n.id)).toEqual(['ID-OK']);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.relPath).toBe('knowledge/architecture/broken.md');
    expect(errors[0]?.code).toBe('FRONTMATTER_PARSE');
    expect(typeof errors[0]?.message).toBe('string');
    expect(errors[0]?.message.length).toBeGreaterThan(0);
  });
});
