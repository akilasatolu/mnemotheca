import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { Frontmatter } from '../../../src/core/frontmatter.js';
import { buildMcpSnippet } from '../../../src/core/mcp-snippet.js';
import { noteAbsPathForCategory, writeNote } from '../../../src/core/note.js';
import { ensureRuntimeDir, runtimePaths, vaultPaths } from '../../../src/core/paths.js';
import { appendUsage } from '../../../src/core/usage-log.js';
import listModules, {
  listCategoriesModule,
  vaultInfoModule,
} from '../../../src/mcp/tools/list.js';
import { tryElicit } from '../../../src/mcp/elicit.js';
import type { ToolContext } from '../../../src/mcp/tools/types.js';
import { makeProject } from '../../helpers/project.js';

const roots: string[] = [];
const origFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = origFetch;
  while (roots.length > 0) {
    const d = roots.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

async function mkProject(): Promise<string> {
  const root = await makeProject();
  roots.push(root);
  return root;
}

function ctx(projectRoot: string): ToolContext {
  return { projectRoot };
}

let seq = 0;
async function addNote(
  root: string,
  category: string,
  slug: string,
  title = `title-${slug}`,
): Promise<void> {
  seq += 1;
  const fm: Frontmatter = {
    id: `20260901T0930${String(seq).padStart(6, '0')}`,
    title,
    categories: [category],
    tags: [],
    created: '2026-09-01T09:30:00+09:00',
    updated: '2026-09-01T09:30:00+09:00',
    summary: '',
  };
  await writeNote(noteAbsPathForCategory(root, category, slug), fm, '## 要約\n\n本文\n');
}

/** 壊れた frontmatter のノートを直接書き込む(parseNote が投げる)。 */
async function addBrokenNote(root: string, category: string, slug: string): Promise<void> {
  const abs = noteAbsPathForCategory(root, category, slug);
  await fs.promises.mkdir(path.dirname(abs), { recursive: true });
  await fs.promises.writeFile(abs, '---\n: : broken yaml :\n---\n本文\n', 'utf8');
}

function structured(res: { structuredContent?: unknown }): Record<string, unknown> {
  return res.structuredContent as Record<string, unknown>;
}

/** projectRoot 配下 + ランタイムスロットの (パス→mtime) スナップショット。 */
function snapshotTree(...dirs: string[]): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out.set(full, fs.statSync(full).mtimeMs);
    }
  };
  for (const d of dirs) walk(d);
  return out;
}

// ───────────────────────── module メタ ─────────────────────────

describe('list.ts — module 登録形', () => {
  it('named export 2 つ + default export = その配列', () => {
    expect(listCategoriesModule.name).toBe('mnemo_list_categories');
    expect(vaultInfoModule.name).toBe('mnemo_get_vault_info');
    expect(listModules).toEqual([listCategoriesModule, vaultInfoModule]);
    for (const m of listModules) {
      expect(m.config.inputSchema).toBeDefined();
      expect(typeof m.handler).toBe('function');
    }
  });
});

// ───────────────────────── mnemo_list_categories(§13-11b)─────────────────────────

describe('mnemo_list_categories', () => {
  it('3 カテゴリ・各 2 ノート + _uncategorized 1 ノート', async () => {
    const root = await mkProject();
    await addNote(root, 'architecture', 'a1');
    await addNote(root, 'architecture', 'a2');
    await addNote(root, 'mcp', 'm1');
    await addNote(root, 'mcp', 'm2');
    await addNote(root, 'ops', 'o1');
    await addNote(root, 'ops', 'o2');
    await addNote(root, '_uncategorized', 'u1');

    // categories/architecture.md の title を明示
    await fs.promises.writeFile(
      path.join(vaultPaths(root).categoriesDir, 'architecture.md'),
      '---\ntitle: アーキテクチャ\n---\n# アーキテクチャ\n',
      'utf8',
    );

    const res = await listCategoriesModule.handler({}, ctx(root));
    const sc = structured(res);
    const cats = sc.categories as { path: string; title: string; noteCount: number }[];

    expect(cats).toHaveLength(3);
    expect(cats.map((c) => c.path)).toEqual(['architecture', 'mcp', 'ops']);
    expect(cats.every((c) => c.noteCount === 2)).toBe(true);
    expect(cats.find((c) => c.path === 'architecture')?.title).toBe('アーキテクチャ');
    // title 未指定はセグメント名にフォールバック
    expect(cats.find((c) => c.path === 'mcp')?.title).toBe('mcp');
    expect(sc.uncategorizedCount).toBe(1);
    expect(sc.totalNotes).toBe(7);
  });

  it('サブディレクトリ化済みカテゴリは 1 エントリとして path が階層表記で出る', async () => {
    const root = await mkProject();
    await addNote(root, 'tech/architecture', 'x1');
    await addNote(root, 'tech/architecture', 'x2');

    await fs.promises.mkdir(path.join(vaultPaths(root).categoriesDir, 'tech'), { recursive: true });
    await fs.promises.writeFile(
      path.join(vaultPaths(root).categoriesDir, 'tech', 'architecture.md'),
      '---\ntitle: 技術/設計\n---\n',
      'utf8',
    );

    const res = await listCategoriesModule.handler({}, ctx(root));
    const cats = structured(res).categories as { path: string; title: string; noteCount: number }[];
    expect(cats).toEqual([{ path: 'tech/architecture', title: '技術/設計', noteCount: 2 }]);
  });

  it('壊れた frontmatter のノートは件数から除外しつつ走査は落ちない', async () => {
    const root = await mkProject();
    await addNote(root, 'architecture', 'ok1');
    await addNote(root, 'architecture', 'ok2');
    await addBrokenNote(root, 'architecture', 'broken');

    const res = await listCategoriesModule.handler({}, ctx(root));
    const sc = structured(res);
    const cats = sc.categories as { path: string; noteCount: number }[];
    expect(cats.find((c) => c.path === 'architecture')?.noteCount).toBe(2);
    expect(sc.totalNotes).toBe(2);
    expect(res.isError).toBeUndefined();
  });

  it('空 vault → categories:[] / totalNotes:0', async () => {
    const root = await mkProject();
    const res = await listCategoriesModule.handler({}, ctx(root));
    const sc = structured(res);
    expect(sc.categories).toEqual([]);
    expect(sc.uncategorizedCount).toBe(0);
    expect(sc.totalNotes).toBe(0);
  });
});

// ───────────────────────── mnemo_get_vault_info(§13-11b)─────────────────────────

async function writeRunJson(
  root: string,
  over: Partial<{ pid: number; port: number; projectRoot: string }> = {},
): Promise<number> {
  await ensureRuntimeDir(root);
  const port = over.port ?? 7777;
  const run = {
    v: 1,
    pid: over.pid ?? process.pid,
    port,
    token: 'test-token',
    projectRoot: over.projectRoot ?? root,
    startedAt: new Date().toISOString(),
  };
  await fs.promises.writeFile(runtimePaths(root).runJson, JSON.stringify(run), 'utf8');
  return port;
}

function stubHealthz(body: unknown, ok = true): void {
  globalThis.fetch = (async () =>
    ({
      ok,
      json: async () => body,
    }) as unknown as Response) as typeof globalThis.fetch;
}

describe('mnemo_get_vault_info', () => {
  it('projectRoot / vaultPath / noteCount / categoryCount が実測値と一致', async () => {
    const root = await mkProject();
    await addNote(root, 'architecture', 'a1');
    await addNote(root, 'architecture', 'a2');
    await addNote(root, 'mcp', 'm1');
    await addNote(root, '_uncategorized', 'u1');

    const res = await vaultInfoModule.handler({}, ctx(root));
    const sc = structured(res);
    expect(sc.projectRoot).toBe(root);
    expect(sc.vaultPath).toBe(vaultPaths(root).root);
    expect(sc.noteCount).toBe(4);
    expect(sc.categoryCount).toBe(2);
    expect(sc.mcpServerKey).toBe(buildMcpSnippet(root).serverKey);
  });

  it('serverRunning: run.json + pid 生存 + healthz projectRoot 一致 → true / serverUrl 付き', async () => {
    const root = await mkProject();
    const port = await writeRunJson(root);
    stubHealthz({ ok: true, projectRoot: root });

    const sc = structured(await vaultInfoModule.handler({}, ctx(root)));
    expect(sc.serverRunning).toBe(true);
    expect(sc.serverUrl).toBe(`http://127.0.0.1:${port}`);
  });

  it('serverRunning: run.json 無し → false / serverUrl:null', async () => {
    const root = await mkProject();
    stubHealthz({ ok: true, projectRoot: root });
    const sc = structured(await vaultInfoModule.handler({}, ctx(root)));
    expect(sc.serverRunning).toBe(false);
    expect(sc.serverUrl).toBeNull();
  });

  it('serverRunning: pid 死亡 → false', async () => {
    const root = await mkProject();
    await writeRunJson(root, { pid: 2147483646 });
    stubHealthz({ ok: true, projectRoot: root });
    const sc = structured(await vaultInfoModule.handler({}, ctx(root)));
    expect(sc.serverRunning).toBe(false);
  });

  it('serverRunning: healthz の projectRoot 不一致 → false', async () => {
    const root = await mkProject();
    await writeRunJson(root);
    stubHealthz({ ok: true, projectRoot: path.join(root, 'other') });
    const sc = structured(await vaultInfoModule.handler({}, ctx(root)));
    expect(sc.serverRunning).toBe(false);
  });

  it('lastStoreAt / lastOrganizeAt: 該当 mode の最新 ts / 履歴なし → null', async () => {
    const root = await mkProject();

    let sc = structured(await vaultInfoModule.handler({}, ctx(root)));
    expect(sc.lastStoreAt).toBeNull();
    expect(sc.lastOrganizeAt).toBeNull();

    await appendUsage(root, {
      ts: '2026-09-01T10:00:00.000Z',
      mode: 'store',
      event: 'store.apply',
      ok: true,
    });
    await appendUsage(root, {
      ts: '2026-09-02T10:00:00.000Z',
      mode: 'store',
      event: 'store.apply',
      ok: true,
    });
    await appendUsage(root, {
      ts: '2026-09-03T10:00:00.000Z',
      mode: 'organize',
      event: 'organize.apply',
      ok: true,
    });

    sc = structured(await vaultInfoModule.handler({}, ctx(root)));
    expect(sc.lastStoreAt).toBe('2026-09-02T10:00:00.000Z');
    expect(sc.lastOrganizeAt).toBe('2026-09-03T10:00:00.000Z');
  });

  it('読み取り専用: 実行前後で vault / .mnemotheca / ランタイムスロットの mtime・ファイル数が不変', async () => {
    const root = await mkProject();
    await addNote(root, 'architecture', 'a1');
    await writeRunJson(root);
    stubHealthz({ ok: true, projectRoot: root });
    await appendUsage(root, {
      ts: '2026-09-01T10:00:00.000Z',
      mode: 'store',
      event: 'store.apply',
      ok: true,
    });

    const dirs = [
      path.join(root, 'vault'),
      path.join(root, '.mnemotheca'),
      runtimePaths(root).dir,
    ];
    const before = snapshotTree(...dirs);
    await vaultInfoModule.handler({}, ctx(root));
    await listCategoriesModule.handler({}, ctx(root));
    const after = snapshotTree(...dirs);

    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [p, m] of before) expect(after.get(p)).toBe(m);
  });
});

// ───────────────────────── mcp/elicit.ts 併記(§13-11b 末尾)─────────────────────────

describe('tryElicit — 非対応 context', () => {
  it('ctx.mcpReq.elicitInput 不在で例外を投げず null を返す', async () => {
    await expect(tryElicit({ mcpReq: undefined }, { foo: 1 })).resolves.toBeNull();
    await expect(tryElicit(undefined, {})).resolves.toBeNull();
  });
});
