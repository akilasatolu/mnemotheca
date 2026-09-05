// test/mcp/tools/show.test.ts — `mnemo_show`(設計 §8-O / §12-5 / §12-6 / test_points §13-12)。
//
// 実プロセスは spawn しない・実ブラウザは開かない・実 listen しない。
// spawn / open / healthz fetch / process.kill はすべて `ShowDeps` で注入する。
// `withLock('run')` だけは本物(proper-lockfile)を使い、並行 show の直列化を検証する。

import { EventEmitter } from 'node:events';
import fs from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { isMnemoError } from '../../../src/core/errors.js';
import { runtimePaths } from '../../../src/core/paths.js';
import { readUsage } from '../../../src/core/usage-log.js';
import {
  createShowModule,
  runShow,
  ShowInputSchema,
  type ShowDeps,
} from '../../../src/mcp/tools/show.js';
import { makeProject } from '../../helpers/project.js';

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
    if (!d) continue;
    fs.rmSync(d, { recursive: true, force: true });
    try {
      fs.rmSync(runtimePaths(d).dir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  }
});

const DEAD_PID = 2_147_483_646; // process.kill(pid, 0) → ESRCH

function writeRunJson(
  root: string,
  over: Partial<{ pid: number; port: number; token: string; projectRoot: string }> = {},
): { pid: number; port: number; token: string } {
  const run = {
    v: 1,
    pid: over.pid ?? process.pid,
    port: over.port ?? 7777,
    token: over.token ?? 'tok-existing',
    startedAt: '2026-09-03T10:00:00+09:00',
    projectRoot: over.projectRoot ?? root,
    version: '0.1.0',
    detached: true,
  };
  const { dir, runJson } = runtimePaths(root);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(runJson, JSON.stringify(run, null, 2));
  return { pid: run.pid, port: run.port, token: run.token };
}

/** EventEmitter ベースの偽 ChildProcess。 */
function fakeChild(): EventEmitter & { unref: () => void; kill: (s?: unknown) => boolean; pid: number } {
  const ee = new EventEmitter() as EventEmitter & {
    unref: () => void;
    kill: (s?: unknown) => boolean;
    pid: number;
  };
  ee.unref = vi.fn();
  ee.kill = vi.fn(() => true);
  ee.pid = 4242;
  return ee;
}

interface ServerState {
  up: boolean;
  root: string;
  port: number;
  /** healthz が返す projectRoot(未指定なら root)。 */
  healthRoot?: string;
}

/** healthz だけを捌く注入 fetch。`state.up` が false / projectRoot 不一致なら未稼働扱いになる。 */
function fakeFetch(state: ServerState): ShowDeps['fetch'] {
  const impl = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/healthz')) {
      if (!state.up) throw new Error('ECONNREFUSED');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          name: 'mnemotheca',
          projectRoot: state.healthRoot ?? state.root,
          port: state.port,
        }),
      } as unknown as Response;
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  return impl as unknown as ShowDeps['fetch'];
}

/** 常に短いタイムアウトを与える基本 deps。 */
function baseDeps(over: Partial<ShowDeps>): Partial<ShowDeps> {
  return {
    healthzTimeoutMs: 50,
    startTimeoutMs: 120,
    pollIntervalMs: 10,
    kill: vi.fn(),
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────

describe('mnemo_show', () => {
  it('inputSchema は空オブジェクトを受理する', () => {
    expect(ShowInputSchema.parse({})).toEqual({});
  });

  it('run.json 生存 & healthz projectRoot 一致 → 起動せず URL を返す', async () => {
    const root = await mkProject();
    const { port, token } = writeRunJson(root, { port: 7780, token: 'tok-live' });
    const spawn = vi.fn();
    const openFn = vi.fn(async () => undefined);

    const out = await runShow(
      root,
      baseDeps({
        fetch: fakeFetch({ up: true, root, port }),
        spawn: spawn as unknown as ShowDeps['spawn'],
        open: openFn,
      }),
    );

    expect(spawn).not.toHaveBeenCalled();
    expect(out).toMatchObject({
      url: `http://127.0.0.1:7780/?t=${token}`,
      started: false,
      browserOpened: true,
      port: 7780,
    });
    expect(openFn).toHaveBeenCalledWith(`http://127.0.0.1:7780/?t=${token}`);
  });

  it('pid 死亡 → stale 掃除して再起動', async () => {
    const root = await mkProject();
    writeRunJson(root, { pid: DEAD_PID, port: 7777, token: 'tok-dead' });
    const state: ServerState = { up: false, root, port: 7781 };

    const spawn = vi.fn(() => {
      // boot 相当: 新しい run.json を書いて healthz を上げる。
      writeRunJson(root, { pid: process.pid, port: 7781, token: 'tok-new' });
      state.up = true;
      return fakeChild();
    });

    const out = await runShow(
      root,
      baseDeps({
        fetch: fakeFetch(state),
        spawn: spawn as unknown as ShowDeps['spawn'],
        open: vi.fn(async () => undefined),
      }),
    );

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ url: 'http://127.0.0.1:7781/?t=tok-new', started: true, port: 7781 });
  });

  it('healthz の projectRoot 不一致 → stale 扱いで再起動', async () => {
    const root = await mkProject();
    writeRunJson(root, { pid: process.pid, port: 7777, token: 'tok-mismatch' });
    // 最初は別 projectRoot を返す healthz。spawn 後に正しい root へ。
    const state: ServerState = { up: true, root, port: 7782, healthRoot: '/somewhere/else' };

    const spawn = vi.fn(() => {
      writeRunJson(root, { pid: process.pid, port: 7782, token: 'tok-fixed' });
      state.healthRoot = root;
      state.port = 7782;
      return fakeChild();
    });

    const out = await runShow(
      root,
      baseDeps({
        fetch: fakeFetch(state),
        spawn: spawn as unknown as ShowDeps['spawn'],
        open: vi.fn(async () => undefined),
      }),
    );

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ started: true, port: 7782, url: 'http://127.0.0.1:7782/?t=tok-fixed' });
  });

  it('ポート 7777 占有 → boot が 7778 で起動、その port を伝播', async () => {
    const root = await mkProject();
    const state: ServerState = { up: false, root, port: 7778 };
    const spawn = vi.fn(() => {
      writeRunJson(root, { pid: process.pid, port: 7778, token: 'tok-7778' });
      state.up = true;
      return fakeChild();
    });

    const out = await runShow(
      root,
      baseDeps({
        fetch: fakeFetch(state),
        spawn: spawn as unknown as ShowDeps['spawn'],
        open: vi.fn(async () => undefined),
      }),
    );

    expect(out.port).toBe(7778);
    expect(out.url).toBe('http://127.0.0.1:7778/?t=tok-7778');
    const onDisk = JSON.parse(fs.readFileSync(runtimePaths(root).runJson, 'utf8')) as { port: number };
    expect(onDisk.port).toBe(7778);
  });

  it('healthz が無応答のまま → SERVER_START_TIMEOUT + 子プロセス SIGKILL', async () => {
    const root = await mkProject();
    const child = fakeChild();
    const spawn = vi.fn(() => child); // run.json を書かない = healthz 上がらない

    const err = await runShow(
      root,
      baseDeps({
        fetch: fakeFetch({ up: false, root, port: 7777 }),
        spawn: spawn as unknown as ShowDeps['spawn'],
        open: vi.fn(async () => undefined),
      }),
    ).catch((e: unknown) => e);

    expect(isMnemoError(err) && err.code).toBe('SERVER_START_TIMEOUT');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(fs.existsSync(runtimePaths(root).runJson)).toBe(false);
  });

  it('boot 子プロセスが 0 以外で早期終了(全ポート枯渇相当)→ SERVER_START_TIMEOUT', async () => {
    const root = await mkProject();
    const child = fakeChild();
    const spawn = vi.fn(() => {
      setTimeout(() => child.emit('exit', 1, null), 5);
      return child;
    });

    const err = await runShow(
      root,
      baseDeps({
        startTimeoutMs: 2000, // タイムアウトではなく早期終了で落ちることを確認
        fetch: fakeFetch({ up: false, root, port: 7777 }),
        spawn: spawn as unknown as ShowDeps['spawn'],
        open: vi.fn(async () => undefined),
      }),
    ).catch((e: unknown) => e);

    expect(isMnemoError(err) && err.code).toBe('SERVER_START_TIMEOUT');
    expect(isMnemoError(err) && err.details?.childExitCode).toBe(1);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('open 失敗 → browserOpened:false、URL は返る(throw しない)', async () => {
    const root = await mkProject();
    writeRunJson(root, { port: 7783, token: 'tok-nobrowser' });

    const out = await runShow(
      root,
      baseDeps({
        fetch: fakeFetch({ up: true, root, port: 7783 }),
        spawn: vi.fn() as unknown as ShowDeps['spawn'],
        open: vi.fn(async () => {
          throw new Error('no display');
        }),
      }),
    );

    expect(out.browserOpened).toBe(false);
    expect(out.url).toBe('http://127.0.0.1:7783/?t=tok-nobrowser');
    expect(out.started).toBe(false);
  });

  it('多重 show 並行 → withLock により spawn は 1 回だけ', async () => {
    const root = await mkProject();
    const state: ServerState = { up: false, root, port: 7784 };
    const spawn = vi.fn(() => {
      writeRunJson(root, { pid: process.pid, port: 7784, token: 'tok-once' });
      state.up = true;
      return fakeChild();
    });

    const deps = baseDeps({
      fetch: fakeFetch(state),
      spawn: spawn as unknown as ShowDeps['spawn'],
      open: vi.fn(async () => undefined),
    });

    const [a, b] = await Promise.all([runShow(root, deps), runShow(root, deps)]);

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(a.url).toBe('http://127.0.0.1:7784/?t=tok-once');
    expect(b.url).toBe('http://127.0.0.1:7784/?t=tok-once');
    expect([a.started, b.started].filter(Boolean)).toHaveLength(1);
  });

  it('checkVault NG(vault/ 不在)→ VAULT_UNAVAILABLE', async () => {
    const root = await mkProject();
    fs.rmSync(`${root}/vault`, { recursive: true, force: true });

    const err = await runShow(
      root,
      baseDeps({
        fetch: fakeFetch({ up: false, root, port: 7777 }),
        spawn: vi.fn() as unknown as ShowDeps['spawn'],
        open: vi.fn(async () => undefined),
      }),
    ).catch((e: unknown) => e);

    expect(isMnemoError(err) && err.code).toBe('VAULT_UNAVAILABLE');
  });

  it('成功時に usage_log へ show.open が追記される', async () => {
    const root = await mkProject();
    writeRunJson(root, { port: 7785, token: 'tok-usage' });

    await runShow(
      root,
      baseDeps({
        fetch: fakeFetch({ up: true, root, port: 7785 }),
        spawn: vi.fn() as unknown as ShowDeps['spawn'],
        open: vi.fn(async () => undefined),
      }),
    );

    const { records } = await readUsage(root);
    expect(records.some((r) => r.mode === 'show' && r.event === 'show.open' && r.ok)).toBe(true);
  });

  it('ToolModule.handler は CallToolResult(text + structuredContent)を返す', async () => {
    const root = await mkProject();
    writeRunJson(root, { port: 7786, token: 'tok-handler' });

    const mod = createShowModule(
      baseDeps({
        fetch: fakeFetch({ up: true, root, port: 7786 }),
        spawn: vi.fn() as unknown as ShowDeps['spawn'],
        open: vi.fn(async () => undefined),
      }),
    );

    const res = await mod.handler({}, { projectRoot: root });
    expect(res.content[0]?.type).toBe('text');
    expect((res.content[0] as { text: string }).text).toContain('http://127.0.0.1:7786/?t=tok-handler');
    expect(res.structuredContent).toMatchObject({ port: 7786, started: false, browserOpened: true });
  });
});
