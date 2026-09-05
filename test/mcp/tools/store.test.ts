// test/mcp/tools/store.test.ts — `mnemo_store`(設計 §8-M / test_points §13-10)。
//
// dry-run → StorePlan・ファイル未作成 / 衝突 3 戦略 / 誤 apply 保険(notesHash + TTL30分)/
// apply 正常(全ファイル作成・categories 再生成・usage_log 追記・パス一覧)/ 原子性(全ロールバック)/
// PII BLOCK / 不変条件 / inputSchema 境界。
//
// 実サーバーは立てない。reindex は run.json 不在によりファイル直更新パスに落ちる。

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { writeNote } from '../../../src/core/note.js';
import type { Frontmatter } from '../../../src/core/frontmatter.js';
import { mnemothecaPaths, runtimePaths, vaultPaths } from '../../../src/core/paths.js';
import storeModule, {
  __resetStoreDryRunMemory,
  StoreInputSchema,
} from '../../../src/mcp/tools/store.js';
import type { ToolContext } from '../../../src/mcp/tools/types.js';
import { makeProject } from '../../helpers/project.js';

const handler = storeModule.handler;

const roots: string[] = [];

async function mkProject(): Promise<string> {
  const root = await makeProject();
  roots.push(root);
  return root;
}

function ctxFor(root: string): ToolContext {
  return { projectRoot: root };
}

beforeEach(() => {
  __resetStoreDryRunMemory();
  vi.useRealTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  while (roots.length > 0) {
    const d = roots.pop();
    if (!d) continue;
    fs.rmSync(d, { recursive: true, force: true });
    try {
      fs.rmSync(runtimePaths(d).dir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  }
});

let slugCounter = 0;
interface NoteOver {
  slug?: string;
  title?: string;
  targetDir?: string;
  categories?: string[];
  tags?: string[];
  summary?: string;
  detail?: string;
  references?: string;
  collisionStrategy?: 'auto-number' | 'append-to-existing' | 'abort';
}

function note(over: NoteOver = {}): Record<string, unknown> {
  slugCounter += 1;
  const targetDir = over.targetDir ?? 'architecture';
  return {
    slug: over.slug ?? `note-${slugCounter}`,
    title: over.title ?? 'あるトピック',
    targetDir,
    categories: over.categories ?? [targetDir],
    tags: over.tags ?? ['aws', 'mcp'],
    summary: over.summary ?? '短い要約です。',
    detail: over.detail ?? '## 詳細\n\n本文の内容。',
    ...(over.references !== undefined ? { references: over.references } : {}),
    ...(over.collisionStrategy !== undefined ? { collisionStrategy: over.collisionStrategy } : {}),
  };
}

function fm(over: Partial<Frontmatter> = {}): Frontmatter {
  return {
    id: '20260903T093015123ab',
    title: '既存ノート',
    categories: ['architecture'],
    tags: ['existing'],
    created: '2026-09-03T09:30:15+09:00',
    updated: '2026-09-03T09:30:15+09:00',
    summary: '既存の要約',
    ...over,
  };
}

async function seedNote(root: string, cat: string, slug: string, body = '## 詳細\n\n既存本文\n'): Promise<string> {
  const abs = path.join(vaultPaths(root).knowledgeDir, cat, `${slug}.md`);
  await writeNote(abs, fm({ categories: [cat] }), body);
  return abs;
}

function noteAbs(root: string, cat: string, slug: string): string {
  return path.join(vaultPaths(root).knowledgeDir, cat, `${slug}.md`);
}

async function dryRun(root: string, notes: Array<Record<string, unknown>>): Promise<void> {
  await handler({ notes }, ctxFor(root));
}

// ───────────────────────── dry-run ─────────────────────────

describe('mnemo_store dry-run (§13-10)', () => {
  it('notes 2 件 → StorePlan に 2 エントリ・ファイル未作成・新規カテゴリを列挙', async () => {
    const root = await mkProject();
    const notes = [
      note({ slug: 'aws-mcp-feasibility', targetDir: 'architecture' }),
      note({ slug: 'elicitation-support', targetDir: 'mcp' }),
    ];

    const res = await handler({ notes }, ctxFor(root));
    const plan = (res.structuredContent as { plan: { willCreate: unknown[]; newCategories: string[] } }).plan;

    expect(res.isError).toBeUndefined();
    expect(plan.willCreate).toHaveLength(2);
    expect(new Set(plan.newCategories)).toEqual(new Set(['architecture', 'mcp']));
    expect(fs.existsSync(noteAbs(root, 'architecture', 'aws-mcp-feasibility'))).toBe(false);
    expect(fs.existsSync(noteAbs(root, 'mcp', 'elicitation-support'))).toBe(false);
    expect((res.content[0] as { text: string }).text).toContain('保存予定');
  });

  it('既存カテゴリは newCategories に出さない', async () => {
    const root = await mkProject();
    await seedNote(root, 'architecture', 'existing-one');

    const res = await handler({ notes: [note({ slug: 'new-note', targetDir: 'architecture' })] }, ctxFor(root));
    const plan = (res.structuredContent as { plan: { newCategories: string[] } }).plan;
    expect(plan.newCategories).toEqual([]);
  });
});

// ───────────────────────── 衝突 3 戦略 ─────────────────────────

describe('mnemo_store 衝突戦略 (§13-10)', () => {
  it('auto-number → プランで slug-2.md', async () => {
    const root = await mkProject();
    await seedNote(root, 'architecture', 'aws-mcp');

    const res = await handler(
      { notes: [note({ slug: 'aws-mcp', targetDir: 'architecture', collisionStrategy: 'auto-number' })] },
      ctxFor(root),
    );
    const entry = (res.structuredContent as { plan: { willCreate: Array<{ path: string; collision: string }> } })
      .plan.willCreate[0]!;
    expect(entry.collision).toBe('auto-number');
    expect(entry.path).toBe('knowledge/architecture/aws-mcp-2.md');
  });

  it('append-to-existing → プランで append', async () => {
    const root = await mkProject();
    await seedNote(root, 'architecture', 'aws-mcp');

    const res = await handler(
      { notes: [note({ slug: 'aws-mcp', collisionStrategy: 'append-to-existing' })] },
      ctxFor(root),
    );
    const entry = (res.structuredContent as { plan: { willCreate: Array<{ collision: string }> } }).plan
      .willCreate[0]!;
    expect(entry.collision).toBe('append');
  });

  it('abort → プランで abort 表示、apply で SLUG_COLLISION', async () => {
    const root = await mkProject();
    await seedNote(root, 'architecture', 'aws-mcp');
    const notes = [note({ slug: 'aws-mcp', collisionStrategy: 'abort' })];

    const dry = await handler({ notes }, ctxFor(root));
    const entry = (dry.structuredContent as { plan: { willCreate: Array<{ collision: string }> } }).plan
      .willCreate[0]!;
    expect(entry.collision).toBe('abort');

    await expect(handler({ notes, apply: true }, ctxFor(root))).rejects.toMatchObject({
      code: 'SLUG_COLLISION',
    });
  });

  it('append-to-existing の apply → 既存ファイルに追記(tags 和集合・updated 更新)', async () => {
    const root = await mkProject();
    const abs = await seedNote(root, 'architecture', 'aws-mcp');
    const notes = [
      note({ slug: 'aws-mcp', tags: ['new-tag'], detail: '追記される本文', collisionStrategy: 'append-to-existing' }),
    ];

    await dryRun(root, notes);
    const res = await handler({ notes, apply: true }, ctxFor(root));

    const content = await fs.promises.readFile(abs, 'utf8');
    expect(content).toContain('## 追記');
    expect(content).toContain('追記される本文');
    expect(content).toContain('existing');
    expect(content).toContain('new-tag');
    expect((res.content[0] as { text: string }).text).toContain('追記');
  });
});

// ───────────────────────── 誤 apply の保険 ─────────────────────────

describe('mnemo_store 誤 apply の保険 (§8-M step 2 / §13-10)', () => {
  it('dry-run 未実施の apply:true → StorePlan を返すだけ・ファイル未作成', async () => {
    const root = await mkProject();
    const notes = [note({ slug: 'unconfirmed', targetDir: 'architecture' })];

    const res = await handler({ notes, apply: true }, ctxFor(root));

    expect(res.isError).toBeUndefined();
    expect((res.structuredContent as { plan?: unknown }).plan).toBeDefined();
    expect((res.content[0] as { text: string }).text).toContain('apply:false');
    expect(fs.existsSync(noteAbs(root, 'architecture', 'unconfirmed'))).toBe(false);
  });

  it('dry-run → apply が通る', async () => {
    const root = await mkProject();
    const notes = [note({ slug: 'confirmed', targetDir: 'architecture' })];

    await dryRun(root, notes);
    const res = await handler({ notes, apply: true }, ctxFor(root));

    expect((res.structuredContent as { created: unknown[] }).created).toHaveLength(1);
    expect(fs.existsSync(noteAbs(root, 'architecture', 'confirmed'))).toBe(true);
  });

  it('TTL 30 分を超えた後の apply → プランのみ(fake timers)', async () => {
    const root = await mkProject();
    const notes = [note({ slug: 'stale-confirm', targetDir: 'architecture' })];

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-03T00:00:00Z'));
    await dryRun(root, notes);

    vi.setSystemTime(new Date('2026-09-03T00:31:00Z'));
    const res = await handler({ notes, apply: true }, ctxFor(root));

    expect((res.structuredContent as { plan?: unknown }).plan).toBeDefined();
    expect(fs.existsSync(noteAbs(root, 'architecture', 'stale-confirm'))).toBe(false);
  });
});

// ───────────────────────── apply 正常系 ─────────────────────────

describe('mnemo_store apply 正常系 (§13-10)', () => {
  it('全ファイル作成・categories 再生成・usage_log 追記・戻り値にパス一覧', async () => {
    const root = await mkProject();
    const notes = [
      note({ slug: 'note-a', targetDir: 'architecture' }),
      note({ slug: 'note-b', targetDir: 'mcp' }),
    ];

    await dryRun(root, notes);
    const res = await handler({ notes, apply: true }, ctxFor(root));

    // 全ファイル作成
    expect(fs.existsSync(noteAbs(root, 'architecture', 'note-a'))).toBe(true);
    expect(fs.existsSync(noteAbs(root, 'mcp', 'note-b'))).toBe(true);

    // categories 再生成
    expect(fs.existsSync(path.join(vaultPaths(root).categoriesDir, 'architecture.md'))).toBe(true);
    expect(fs.existsSync(path.join(vaultPaths(root).categoriesDir, 'mcp.md'))).toBe(true);

    // usage_log 追記
    const log = await fs.promises.readFile(mnemothecaPaths(root).usageLogJsonl, 'utf8');
    const rec = JSON.parse(log.trim().split('\n').pop()!) as { event: string; ok: boolean; paths: string[] };
    expect(rec.event).toBe('store.apply');
    expect(rec.ok).toBe(true);
    expect(rec.paths).toEqual([
      'knowledge/architecture/note-a.md',
      'knowledge/mcp/note-b.md',
    ]);

    // 戻り値
    const created = (res.structuredContent as { created: Array<{ path: string; id: string }> }).created;
    expect(created.map((c) => c.path)).toEqual([
      'knowledge/architecture/note-a.md',
      'knowledge/mcp/note-b.md',
    ]);
    expect(created.every((c) => /^[0-9]{8}T[0-9]{9}[a-z0-9]{5}$/.test(c.id))).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain('2 件保存しました');
  });
});

// ───────────────────────── 原子性 ─────────────────────────

describe('mnemo_store 原子性 (§13-10)', () => {
  it('2 件目の書き込み失敗 → 1 件目も消える(全ロールバック)', async () => {
    const root = await mkProject();
    const notes = [
      note({ slug: 'atomic-a', targetDir: 'architecture' }),
      note({ slug: 'atomic-b', targetDir: 'architecture' }),
    ];
    await dryRun(root, notes);

    const realRename = fs.promises.rename.bind(fs.promises);
    let calls = 0;
    vi.spyOn(fs.promises, 'rename').mockImplementation(((...args: Parameters<typeof fs.promises.rename>) => {
      calls += 1;
      if (calls === 2) return Promise.reject(new Error('disk full (simulated)'));
      return realRename(...args);
    }) as typeof fs.promises.rename);

    await expect(handler({ notes, apply: true }, ctxFor(root))).rejects.toThrow();

    vi.restoreAllMocks();
    expect(fs.existsSync(noteAbs(root, 'architecture', 'atomic-a'))).toBe(false);
    expect(fs.existsSync(noteAbs(root, 'architecture', 'atomic-b'))).toBe(false);
  });
});

// ───────────────────────── PII ─────────────────────────

describe('mnemo_store PII BLOCK (§13-10)', () => {
  const AWS_EXAMPLE_KEY = 'AKIAIOSFODNN7EXAMPLE'; // AWS 公式ドキュメントの example 値

  it('dry-run は piiBlocks を提示し、apply は PII_BLOCKED・ファイル未作成', async () => {
    const root = await mkProject();
    const notes = [
      note({ slug: 'leaky', targetDir: 'architecture', detail: `AWS キー: ${AWS_EXAMPLE_KEY} を使う` }),
    ];

    const dry = await handler({ notes }, ctxFor(root));
    const plan = (dry.structuredContent as { plan: { piiBlocks: unknown[] } }).plan;
    expect(plan.piiBlocks.length).toBeGreaterThan(0);

    await expect(handler({ notes, apply: true }, ctxFor(root))).rejects.toMatchObject({
      code: 'PII_BLOCKED',
    });
    expect(fs.existsSync(noteAbs(root, 'architecture', 'leaky'))).toBe(false);
  });
});

// ───────────────────────── 不変条件 ─────────────────────────

describe('mnemo_store 不変条件 (§13-10)', () => {
  it('categories[0] にスラッシュ → CATEGORY_INVARIANT', async () => {
    const root = await mkProject();
    const notes = [note({ slug: 'inv-1', targetDir: 'tech', categories: ['tech/arch'] })];
    await dryRun(root, notes);
    await expect(handler({ notes, apply: true }, ctxFor(root))).rejects.toMatchObject({
      code: 'CATEGORY_INVARIANT',
    });
    expect(fs.existsSync(noteAbs(root, 'tech', 'inv-1'))).toBe(false);
  });

  it('targetDir != categories[0] → CATEGORY_INVARIANT', async () => {
    const root = await mkProject();
    const notes = [note({ slug: 'inv-2', targetDir: 'architecture', categories: ['ml'] })];
    await dryRun(root, notes);
    await expect(handler({ notes, apply: true }, ctxFor(root))).rejects.toMatchObject({
      code: 'CATEGORY_INVARIANT',
    });
  });
});

// ───────────────────────── inputSchema 境界 ─────────────────────────

describe('mnemo_store inputSchema 境界 (§13-10)', () => {
  it('notes 空配列 → バリデーションエラー', async () => {
    const root = await mkProject();
    await expect(handler({ notes: [] }, ctxFor(root))).rejects.toThrow();
    expect(() => StoreInputSchema.parse({ notes: [] })).toThrow();
  });

  it('notes 31 件 → バリデーションエラー', async () => {
    const root = await mkProject();
    const notes = Array.from({ length: 31 }, (_, i) => note({ slug: `over-${i}` }));
    await expect(handler({ notes }, ctxFor(root))).rejects.toThrow();
  });

  it('collisionStrategy 省略時は auto-number が既定', () => {
    const parsed = StoreInputSchema.parse({ notes: [note({ slug: 'defaulted' })] });
    expect(parsed.notes[0]!.collisionStrategy).toBe('auto-number');
    expect(parsed.apply).toBe(false);
  });
});
