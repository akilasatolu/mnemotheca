// test/cli/reindex.test.ts — `mnemo reindex [--full] [--no-categories]`(設計書 §6-6 / §9-1 / §13-14)。
//
// test_points(§13-14):
//   - `mnemo reindex --full`: インデックスキャッシュ(search-index.json / meta.json)削除 → 再構築。
//     稼働中サーバーがあれば API 経由(reindexPaths が via:'server' を返す)も叩く。
//   - 差分 / 直更新の分岐(§13-10 と同じ = サーバー稼働 → server 経由 / 未稼働 → direct)。
//   - `--no-categories` で `regenerateCategories` が呼ばれない(既定は呼ばれる)。
//
// `reindexPaths` / `regenerateCategories` はモジュールモックし、既定は実装へ委譲(`vi.fn(actual)`)。
// 分岐テストは `mockResolvedValueOnce` で上書き、実インデックス構築ケースは委譲のまま実行する。

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { run } from '../../src/cli/index.js';
import { reindexPaths } from '../../src/mcp/reindex-client.js';
import { regenerateCategories } from '../../src/core/categories-index.js';
import { noteAbsPathForCategory, writeNote } from '../../src/core/note.js';
import { mnemothecaPaths, runtimePaths } from '../../src/core/paths.js';
import type { Frontmatter } from '../../src/core/frontmatter.js';
import { makeProject } from '../helpers/project.js';

vi.mock('../../src/mcp/reindex-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/mcp/reindex-client.js')>();
  return { ...actual, reindexPaths: vi.fn(actual.reindexPaths) };
});

vi.mock('../../src/core/categories-index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/categories-index.js')>();
  return { ...actual, regenerateCategories: vi.fn(actual.regenerateCategories) };
});

const mockedReindexPaths = vi.mocked(reindexPaths);
const mockedRegen = vi.mocked(regenerateCategories);

const roots: string[] = [];

async function mkProject(): Promise<string> {
  // resolveProjectRoot が realpath 解決するため、テスト側も realpath を基準にする。
  const root = fs.realpathSync.native(await makeProject());
  roots.push(root);
  return root;
}

afterEach(() => {
  vi.clearAllMocks();
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

/** stdout / stderr をキャプチャして `run()` を実行する。 */
async function capture(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const o = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
    out.push(String(c));
    return true;
  });
  const e = vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
    err.push(String(c));
    return true;
  });
  try {
    const code = await run(argv, { cwd: process.cwd() });
    return { code, out: out.join(''), err: err.join('') };
  } finally {
    o.mockRestore();
    e.mockRestore();
  }
}

function okResult(over: Partial<Awaited<ReturnType<typeof reindexPaths>>> = {}): Awaited<
  ReturnType<typeof reindexPaths>
> {
  return {
    ok: true,
    via: 'direct',
    serverFellBack: false,
    full: false,
    added: 0,
    updated: 0,
    removed: 0,
    tookMs: 1,
    ...over,
  };
}

let idc = 0;
function fm(over: Partial<Frontmatter> = {}): Frontmatter {
  idc += 1;
  return {
    id: `20260903T093015${String(idc).padStart(3, '0')}zz`,
    title: 'タイトル',
    categories: ['architecture'],
    tags: ['mcp'],
    created: '2026-09-03T09:30:15+09:00',
    updated: '2026-09-03T09:30:15+09:00',
    summary: '要約',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 差分 / 直更新の分岐(§13-14 / §13-10 と同分岐)
// ---------------------------------------------------------------------------

describe('mnemo reindex — サーバー稼働 / 未稼働の分岐(§6-6)', () => {
  it('未稼働: reindexPaths を差分(full=false)で呼び、via:direct を出力', async () => {
    const root = await mkProject();
    mockedReindexPaths.mockResolvedValueOnce(okResult({ via: 'direct', added: 1 }));

    const { code, out } = await capture(['--project', root, '--json', 'reindex']);

    expect(code).toBe(0);
    expect(mockedReindexPaths).toHaveBeenCalledWith(root, undefined, { full: false });
    const json = JSON.parse(out) as Record<string, unknown>;
    expect(json).toMatchObject({ ok: true, full: false, via: 'direct', serverFellBack: false, added: 1 });
  });

  it('稼働中: reindexPaths が via:server を返せばそれを出力', async () => {
    const root = await mkProject();
    mockedReindexPaths.mockResolvedValueOnce(
      okResult({ via: 'server', full: false, added: 3, updated: 1 }),
    );

    const { code, out } = await capture(['--project', root, '--json', 'reindex']);

    expect(code).toBe(0);
    const json = JSON.parse(out) as Record<string, unknown>;
    expect(json).toMatchObject({ via: 'server', added: 3, updated: 1 });
  });

  it('サーバーフォールバック時は警告 1 行を付記する(§12-11)', async () => {
    const root = await mkProject();
    mockedReindexPaths.mockResolvedValueOnce(okResult({ via: 'direct', serverFellBack: true }));

    const { code, out } = await capture(['--project', root, 'reindex']);

    expect(code).toBe(0);
    expect(out).toContain('ファイルを直接更新しました');
  });
});

// ---------------------------------------------------------------------------
// --full: キャッシュ削除 → 再構築(§13-14)
// ---------------------------------------------------------------------------

describe('mnemo reindex --full(§6-6)', () => {
  it('search-index.json / meta.json を削除してから reindexPaths を full=true で呼ぶ', async () => {
    const root = await mkProject();
    const p = mnemothecaPaths(root);
    await fs.promises.writeFile(p.searchIndexJson, '{"stale":true}\n');
    await fs.promises.writeFile(p.metaJson, '{"stale":true}\n');

    mockedReindexPaths.mockResolvedValueOnce(okResult({ via: 'server', full: true, added: 2 }));

    const { code, out } = await capture(['--project', root, '--json', 'reindex', '--full']);

    expect(code).toBe(0);
    // キャッシュが消えていること。
    expect(fs.existsSync(p.searchIndexJson)).toBe(false);
    expect(fs.existsSync(p.metaJson)).toBe(false);
    expect(mockedReindexPaths).toHaveBeenCalledWith(root, undefined, { full: true });
    const json = JSON.parse(out) as Record<string, unknown>;
    expect(json).toMatchObject({ full: true, via: 'server' });
  });

  it('キャッシュが存在しなくてもエラーにしない', async () => {
    const root = await mkProject();
    mockedReindexPaths.mockResolvedValueOnce(okResult({ full: true }));
    const { code } = await capture(['--project', root, '--json', 'reindex', '--full']);
    expect(code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// --no-categories(§13-14)
// ---------------------------------------------------------------------------

describe('mnemo reindex --no-categories(§6-6)', () => {
  it('既定では regenerateCategories が呼ばれる', async () => {
    const root = await mkProject();
    mockedReindexPaths.mockResolvedValueOnce(okResult());
    mockedRegen.mockResolvedValueOnce({ written: 1, removed: 0 });

    const { code, out } = await capture(['--project', root, '--json', 'reindex']);

    expect(code).toBe(0);
    expect(mockedRegen).toHaveBeenCalledWith(root);
    const json = JSON.parse(out) as Record<string, unknown>;
    expect(json.categories).toEqual({ written: 1, removed: 0 });
  });

  it('--no-categories で regenerateCategories が呼ばれない', async () => {
    const root = await mkProject();
    mockedReindexPaths.mockResolvedValueOnce(okResult());

    const { code, out } = await capture(['--project', root, '--json', 'reindex', '--no-categories']);

    expect(code).toBe(0);
    expect(mockedRegen).not.toHaveBeenCalled();
    const json = JSON.parse(out) as Record<string, unknown>;
    expect(json.categories).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 実インデックス構築(モック委譲のまま 1 ケース・§13-14 / §13-16)
// ---------------------------------------------------------------------------

describe('mnemo reindex — 実インデックス構築(サーバー未稼働・直更新)', () => {
  it('--full でキャッシュを実際に再構築し usage_log に記録する', async () => {
    const root = await mkProject();
    await writeNote(
      noteAbsPathForCategory(root, 'architecture', 'note-a'),
      fm({ categories: ['architecture'] }),
      '## 詳細\n\n本文A\n',
    );
    await writeNote(
      noteAbsPathForCategory(root, 'tech', 'note-b'),
      fm({ categories: ['tech'] }),
      '## 詳細\n\n本文B\n',
    );

    const p = mnemothecaPaths(root);
    const { code, out } = await capture(['--project', root, '--json', 'reindex', '--full']);

    expect(code).toBe(0);
    // 実 buildIndex 経由でキャッシュが生成される。
    expect(fs.existsSync(p.searchIndexJson)).toBe(true);
    expect(fs.existsSync(p.metaJson)).toBe(true);
    // 実 regenerateCategories でカテゴリファイルが生成される。
    expect(fs.existsSync(path.join(root, 'vault', 'categories', 'architecture.md'))).toBe(true);

    const json = JSON.parse(out) as Record<string, unknown>;
    expect(json).toMatchObject({ ok: true, full: true, via: 'direct' });
    expect(json.added).toBe(2);

    const log = await fs.promises.readFile(p.usageLogJsonl, 'utf8');
    const rec = JSON.parse(log.trim().split('\n').pop() as string) as Record<string, unknown>;
    expect(rec).toMatchObject({ mode: 'reindex', event: 'reindex', ok: true, count: 2 });
  });
});
