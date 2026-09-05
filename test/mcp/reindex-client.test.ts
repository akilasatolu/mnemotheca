// test/mcp/reindex-client.test.ts — 設計 §6-6 +「内部 API 呼び出しの認証」小節。
// test_points: §13-10(store apply がサーバー経由/直更新の両分岐)+ §13-14(`mnemo reindex` の同分岐)。
//
// `fetch` は注入 or `vi.spyOn(globalThis,'fetch')` でスタブし、実サーバーは立てない。

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { noteAbsPathForCategory, noteRelPath, writeNote } from '../../src/core/note.js';
import type { Frontmatter } from '../../src/core/frontmatter.js';
import { loadIndex } from '../../src/core/search.js';
import { runtimePaths } from '../../src/core/paths.js';
import {
  detectRunningServer,
  reindexPaths,
  type FetchLike,
} from '../../src/mcp/reindex-client.js';
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
    // ランタイム側スロット(run.json / locks)も掃除。
    if (d) {
      try {
        fs.rmSync(runtimePaths(d).dir, { recursive: true, force: true });
      } catch {
        /* noop */
      }
    }
  }
});

const DEAD_PID = 2_147_483_646; // まず存在しない pid(process.kill(pid,0) → ESRCH)

async function writeRunJson(
  root: string,
  over: Partial<{ pid: number; port: number; token: string; projectRoot: string }> = {},
): Promise<{ pid: number; port: number; token: string }> {
  const run = {
    v: 1,
    pid: over.pid ?? process.pid,
    port: over.port ?? 7777,
    token: over.token ?? 'test-token-abc',
    startedAt: '2026-09-03T10:00:00+09:00',
    projectRoot: over.projectRoot ?? root,
    version: '0.1.0',
    detached: true,
  };
  const { dir, runJson } = runtimePaths(root);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(runJson, JSON.stringify(run, null, 2));
  return { pid: run.pid, port: run.port, token: run.token };
}

interface Route {
  ok: boolean;
  status: number;
  body: unknown;
}

/** healthz と /api/reindex を捌く最小の fake fetch。`throwOn` に含まれる経路は reject する。 */
function fakeFetch(opts: {
  root: string;
  port?: number;
  reindex?: Route;
  throwOn?: Array<'healthz' | 'reindex'>;
}): FetchLike {
  const port = opts.port ?? 7777;
  const impl = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/healthz')) {
      if (opts.throwOn?.includes('healthz')) throw new Error('healthz network error');
      return jsonResponse(true, 200, {
        ok: true,
        name: 'mnemotheca',
        version: '0.1.0',
        projectRoot: opts.root,
        vaultPath: path.join(opts.root, 'vault'),
        port,
        startedAt: '2026-09-03T10:00:00+09:00',
      });
    }
    if (url.includes('/api/reindex')) {
      if (opts.throwOn?.includes('reindex')) throw new Error('reindex timeout');
      const r = opts.reindex ?? {
        ok: true,
        status: 200,
        body: { added: 2, updated: 0, removed: 0, tookMs: 5 },
      };
      return jsonResponse(r.ok, r.status, r.body);
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  return impl as unknown as FetchLike;
}

function jsonResponse(ok: boolean, status: number, body: unknown): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

let idCounter = 0;
function fm(over: Partial<Frontmatter> = {}): Frontmatter {
  idCounter += 1;
  return {
    id: `20260903T093015${String(idCounter).padStart(3, '0')}ab`,
    title: 'タイトル',
    categories: ['architecture'],
    tags: ['aws', 'mcp'],
    created: '2026-09-03T09:30:15+09:00',
    updated: '2026-09-03T09:30:15+09:00',
    summary: '要約',
    ...over,
  };
}

async function addNote(root: string, cat: string, slug: string): Promise<string> {
  const abs = noteAbsPathForCategory(root, cat, slug);
  await writeNote(abs, fm({ categories: [cat] }), `## 詳細\n\n${slug} の本文\n`);
  return noteRelPath(root, abs);
}

// ---------------------------------------------------------------------------
// detectRunningServer(§6-6 / §8-O / §13-11b)
// ---------------------------------------------------------------------------

describe('detectRunningServer() (§6-6 / §8-O)', () => {
  it('run.json が無ければ未稼働(run:null)', async () => {
    const root = await mkProject();
    const d = await detectRunningServer(root, { fetch: fakeFetch({ root }) });
    expect(d).toEqual({ running: false, run: null, url: null });
  });

  it('run.json が JSON 破損なら未稼働', async () => {
    const root = await mkProject();
    const { dir, runJson } = runtimePaths(root);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(runJson, '{ broken');
    const d = await detectRunningServer(root, { fetch: fakeFetch({ root }) });
    expect(d.running).toBe(false);
    expect(d.run).toBeNull();
  });

  it('run.json の projectRoot が不一致なら未稼働(healthz を叩かない)', async () => {
    const root = await mkProject();
    await writeRunJson(root, { projectRoot: path.join(root, 'other') });
    const f = fakeFetch({ root });
    const d = await detectRunningServer(root, { fetch: f });
    expect(d.running).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it('pid が死んでいれば未稼働', async () => {
    const root = await mkProject();
    await writeRunJson(root, { pid: DEAD_PID });
    const d = await detectRunningServer(root, { fetch: fakeFetch({ root }) });
    expect(d.running).toBe(false);
  });

  it('healthz の projectRoot が不一致なら未稼働', async () => {
    const root = await mkProject();
    await writeRunJson(root);
    const badHealth = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes('/healthz')) {
        return jsonResponse(true, 200, { ok: true, projectRoot: '/somewhere/else' });
      }
      throw new Error('nope');
    }) as unknown as FetchLike;
    const d = await detectRunningServer(root, { fetch: badHealth });
    expect(d.running).toBe(false);
  });

  it('pid 生存 + healthz 一致で稼働中(url を返す)', async () => {
    const root = await mkProject();
    await writeRunJson(root, { port: 7788 });
    const d = await detectRunningServer(root, { fetch: fakeFetch({ root, port: 7788 }) });
    expect(d.running).toBe(true);
    expect(d.url).toBe('http://127.0.0.1:7788');
    expect(d.run?.token).toBe('test-token-abc');
  });
});

// ---------------------------------------------------------------------------
// reindexPaths — サーバー経由(§13-10 / §13-14)
// ---------------------------------------------------------------------------

describe('reindexPaths() サーバー経由 (§6-6)', () => {
  it('稼働中サーバーに POST /api/reindex、Bearer トークン + paths を付与', async () => {
    const root = await mkProject();
    const { token } = await writeRunJson(root);
    const f = fakeFetch({ root });

    const res = await reindexPaths(root, ['knowledge/architecture/a.md'], { fetch: f });

    expect(res).toMatchObject({
      ok: true,
      via: 'server',
      serverFellBack: false,
      full: false,
      added: 2,
      updated: 0,
      removed: 0,
      tookMs: 5,
    });

    const call = (f as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
      String(c[0]).includes('/api/reindex'),
    );
    expect(call).toBeDefined();
    const init = call?.[1] as RequestInit;
    expect(String(call?.[0])).toBe('http://127.0.0.1:7777/api/reindex');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${token}`);
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(init.body))).toEqual({
      full: false,
      paths: ['knowledge/architecture/a.md'],
    });
  });

  it('full:true で body に full:true(paths 省略なら paths は付けない)', async () => {
    const root = await mkProject();
    await writeRunJson(root);
    const f = fakeFetch({ root });

    const res = await reindexPaths(root, undefined, { fetch: f, full: true });
    expect(res.via).toBe('server');
    expect(res.full).toBe(true);

    const call = (f as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
      String(c[0]).includes('/api/reindex'),
    );
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({ full: true });
  });

  it('vi.spyOn(globalThis,"fetch") のスタブ経由でもサーバー経由になる', async () => {
    const root = await mkProject();
    await writeRunJson(root);
    if (typeof globalThis.fetch !== 'function') {
      // 環境に fetch が無ければ skip 相当(注入版で網羅済み)。
      return;
    }
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      fakeFetch({ root }) as unknown as typeof globalThis.fetch,
    );
    const res = await reindexPaths(root, ['knowledge/x/y.md']);
    expect(res.via).toBe('server');
    expect(res.added).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// reindexPaths — 直更新フォールバック(§13-10 / §13-14 / §12-11)
// ---------------------------------------------------------------------------

describe('reindexPaths() 直更新フォールバック (§6-6 / §12-11)', () => {
  it('サーバー無し(run.json 無し)→ 最初から直更新・serverFellBack:false', async () => {
    const root = await mkProject();
    await addNote(root, 'architecture', 'a');
    await addNote(root, 'ml', 'b');

    const f = fakeFetch({ root });
    const res = await reindexPaths(root, undefined, { fetch: f, full: true });

    expect(res.via).toBe('direct');
    expect(res.serverFellBack).toBe(false);
    expect(res.added).toBe(2);
    expect(f).not.toHaveBeenCalled();

    const h = await loadIndex(root);
    expect(h.meta.docCount).toBe(2);
  });

  it('healthz 不一致 → 直更新パス(serverFellBack:false)', async () => {
    const root = await mkProject();
    await addNote(root, 'architecture', 'a');
    await writeRunJson(root);
    const badHealth = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes('/healthz')) {
        return jsonResponse(true, 200, { ok: true, projectRoot: '/elsewhere' });
      }
      throw new Error('reindex must not be called');
    }) as unknown as FetchLike;

    const res = await reindexPaths(root, undefined, { fetch: badHealth, full: true });
    expect(res.via).toBe('direct');
    expect(res.serverFellBack).toBe(false);
    expect(res.added).toBe(1);
  });

  it('サーバー生存だが API が非2xx(500)→ 直更新にフォールバック・serverFellBack:true', async () => {
    const root = await mkProject();
    await addNote(root, 'architecture', 'a');
    await writeRunJson(root);
    const f = fakeFetch({
      root,
      reindex: { ok: false, status: 500, body: { error: { code: 'INDEX_BUILD_FAILED' } } },
    });

    const res = await reindexPaths(root, undefined, { fetch: f, full: true });
    expect(res.via).toBe('direct');
    expect(res.serverFellBack).toBe(true);
    expect(res.added).toBe(1);

    const h = await loadIndex(root);
    expect(h.meta.docCount).toBe(1);
  });

  it('サーバー生存だが API がタイムアウト(reject)→ 直更新にフォールバック・serverFellBack:true', async () => {
    const root = await mkProject();
    await addNote(root, 'architecture', 'a');
    await writeRunJson(root);
    const f = fakeFetch({ root, throwOn: ['reindex'] });

    const res = await reindexPaths(root, ['knowledge/architecture/a.md'], { fetch: f });
    expect(res.via).toBe('direct');
    expect(res.serverFellBack).toBe(true);
    // 差分(syncIndex)経路でファイルが直接更新される。
    const h = await loadIndex(root);
    expect(h.meta.docCount).toBe(1);
  });

  it('差分(full 省略)経路: 既存インデックスに対する追加/削除を反映', async () => {
    const root = await mkProject();
    await addNote(root, 'architecture', 'a');
    await addNote(root, 'architecture', 'b');

    // 1 回目(直更新・full)で 2 件をインデックス化。
    await reindexPaths(root, undefined, { fetch: fakeFetch({ root }), full: true });

    // 1 件削除して差分再インデックス。
    fs.rmSync(noteAbsPathForCategory(root, 'architecture', 'b'));
    const res = await reindexPaths(root, undefined, { fetch: fakeFetch({ root }) });

    expect(res.via).toBe('direct');
    expect(res.full).toBe(false);
    expect(res.removed).toBe(1);

    const h = await loadIndex(root);
    expect(h.meta.docCount).toBe(1);
  });
});
