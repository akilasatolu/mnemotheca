// test/cli/lifecycle.test.ts — `mnemo start / stop / status / open`(設計 §9-1 / §9-6 / §13-14)。
//
// 実 listen・実ブラウザ起動・実プロセスへのシグナル送信は一切行わない。
// `startServer` / ブラウザ起動 / `process.kill` / pid 生存確認 / サーバー検出はすべて
// 各コマンドの `*Deps` 注入ポイントでモックする。

import fs from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { isMnemoError } from '../../src/core/errors.js';
import { runtimePaths } from '../../src/core/paths.js';
import type { ServerDetection } from '../../src/mcp/reindex-client.js';
import type { StartedServer } from '../../src/server/boot.js';
import type { CliCommandContext } from '../../src/cli/index.js';
import { run as runStart, type StartDeps } from '../../src/cli/commands/start.js';
import { run as runStop, type StopDeps } from '../../src/cli/commands/stop.js';
import { run as runStatus, type StatusDeps } from '../../src/cli/commands/status.js';
import { run as runOpen, type OpenDeps } from '../../src/cli/commands/open.js';
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
    if (d === undefined) continue;
    fs.rmSync(d, { recursive: true, force: true });
    try {
      fs.rmSync(runtimePaths(d).dir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  }
});

// ─────────────────────────── 共通ヘルパ ───────────────────────────

interface CtxOver {
  options?: Record<string, unknown>;
  global?: Partial<CliCommandContext['global']>;
  projectRoot?: string | undefined;
}

function makeCtx(name: CliCommandContext['name'], projectRoot: string, over: CtxOver = {}): CliCommandContext {
  return {
    name,
    args: [],
    options: over.options ?? {},
    global: {
      project: undefined,
      json: false,
      quiet: false,
      ...over.global,
    },
    projectRoot: 'projectRoot' in over ? over.projectRoot : projectRoot,
  };
}

/** 行を貯める write。 */
function sink(): { lines: string[]; write: (l: string) => void; text: () => string } {
  const lines: string[] = [];
  return { lines, write: (l: string) => void lines.push(l), text: () => lines.join('\n') };
}

function fakeStarted(over: Partial<StartedServer> = {}): StartedServer {
  return {
    port: 7777,
    token: 'tok-abc',
    stop: vi.fn(async () => {}),
    selfCheckTick: async () => {},
    ...over,
  };
}

function writeRunJson(root: string, over: Partial<{ pid: number; port: number; token: string }> = {}): void {
  const { dir, runJson } = runtimePaths(root);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    runJson,
    JSON.stringify({
      v: 1,
      pid: over.pid ?? process.pid,
      port: over.port ?? 7777,
      token: over.token ?? 'tok-run',
      startedAt: '2026-09-03T10:00:00+09:00',
      projectRoot: root,
      version: '0.1.0',
      detached: false,
    }),
  );
}

function detection(over: Partial<ServerDetection> & { port?: number; token?: string; pid?: number } = {}): ServerDetection {
  const running = over.running ?? true;
  const port = over.port ?? 7777;
  if (!running) {
    return { running: false, run: over.run ?? null, url: null };
  }
  return {
    running: true,
    run: {
      v: 1,
      pid: over.pid ?? process.pid,
      port,
      token: over.token ?? 'tok-live',
      projectRoot: '/x',
    },
    url: over.url ?? `http://127.0.0.1:${port}`,
  };
}

// ─────────────────────────── mnemo start ───────────────────────────

describe('mnemo start', () => {
  function baseStartDeps(over: Partial<StartDeps>): Partial<StartDeps> {
    return {
      startServer: vi.fn(async () => fakeStarted()),
      open: vi.fn(async () => undefined),
      waitForShutdown: vi.fn(async () => 'SIGINT' as NodeJS.Signals),
      ...over,
    };
  }

  it('--no-open: サーバーを起動し、ブラウザは開かず、SIGINT で stop() する', async () => {
    const root = await mkProject();
    // stop() が run.json を消すことまで検証するため、事前に置いておく。
    writeRunJson(root);
    const runJsonPath = runtimePaths(root).runJson;

    const started = fakeStarted({
      stop: vi.fn(async () => {
        await fs.promises.rm(runJsonPath, { force: true });
      }),
    });
    const open = vi.fn(async () => undefined);
    const out = sink();

    await runStart(makeCtx('start', root, { options: { open: false } }), {
      ...baseStartDeps({ open }),
      startServer: vi.fn(async () => started),
      write: out.write,
    });

    expect(open).not.toHaveBeenCalled();
    expect(started.stop).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(runJsonPath)).toBe(false);
    expect(out.text()).toContain('起動しました');
  });

  it('既定ではトークン付き URL をブラウザで開く', async () => {
    const root = await mkProject();
    const open = vi.fn(async () => undefined);

    await runStart(makeCtx('start', root, { options: {} }), {
      ...baseStartDeps({ open }),
      write: () => {},
    });

    expect(open).toHaveBeenCalledWith('http://127.0.0.1:7777/?t=tok-abc');
  });

  it('--port を startServer に渡す。不正な --port は PORT_UNAVAILABLE', async () => {
    const root = await mkProject();
    const startServer = vi.fn(async () => fakeStarted());

    await runStart(makeCtx('start', root, { options: { port: '8080', open: false } }), {
      ...baseStartDeps({}),
      startServer,
      write: () => {},
    });
    expect(startServer).toHaveBeenCalledWith(expect.objectContaining({ projectRoot: root, detached: false, port: 8080 }));

    const err = await runStart(makeCtx('start', root, { options: { port: 'abc' } }), baseStartDeps({})).catch(
      (e: unknown) => e,
    );
    expect(isMnemoError(err) && err.code).toBe('PORT_UNAVAILABLE');
  });

  it('ブラウザ起動が失敗しても throw しない', async () => {
    const root = await mkProject();
    await expect(
      runStart(makeCtx('start', root, { options: {} }), {
        ...baseStartDeps({ open: vi.fn(async () => { throw new Error('no browser'); }) }),
        write: () => {},
      }),
    ).resolves.toBeUndefined();
  });

  it('--json: URL / port / projectRoot を 1 行で出力する', async () => {
    const root = await mkProject();
    const out = sink();
    await runStart(makeCtx('start', root, { options: { open: false }, global: { json: true } }), {
      ...baseStartDeps({}),
      write: out.write,
    });
    expect(JSON.parse(out.text())).toEqual({
      url: 'http://127.0.0.1:7777/?t=tok-abc',
      port: 7777,
      projectRoot: root,
    });
  });
});

// ─────────────────────────── mnemo stop ───────────────────────────

describe('mnemo stop', () => {
  function baseStopDeps(over: Partial<StopDeps>): Partial<StopDeps> {
    return {
      kill: vi.fn(),
      isAlive: vi.fn(() => false),
      sleep: vi.fn(async () => {}),
      gracePeriodMs: 1000,
      pollIntervalMs: 200,
      ...over,
    };
  }

  it('run.json が無ければ「起動していません」', async () => {
    const root = await mkProject();
    const out = sink();
    const kill = vi.fn();
    await runStop(makeCtx('stop', root), { ...baseStopDeps({ kill }), write: out.write });
    expect(kill).not.toHaveBeenCalled();
    expect(out.text()).toContain('起動していません');
  });

  it('SIGTERM で消滅を確認できたら SIGKILL しない・run.json を削除する', async () => {
    const root = await mkProject();
    writeRunJson(root, { pid: 4242 });
    const runJsonPath = runtimePaths(root).runJson;
    const kill = vi.fn();
    // 1 回目のポーリングで死亡。
    const isAlive = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    const out = sink();

    await runStop(makeCtx('stop', root), { ...baseStopDeps({ kill, isAlive }), write: out.write });

    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(4242, 'SIGTERM');
    expect(fs.existsSync(runJsonPath)).toBe(false);
    expect(out.text()).toContain('停止しました');
    expect(out.text()).not.toContain('SIGKILL');
  });

  it('SIGTERM 後も生存し続ける → SIGKILL で強制終了して run.json を削除する', async () => {
    const root = await mkProject();
    writeRunJson(root, { pid: 4242 });
    const runJsonPath = runtimePaths(root).runJson;
    const kill = vi.fn();
    const isAlive = vi.fn(() => true);
    const out = sink();

    await runStop(makeCtx('stop', root), { ...baseStopDeps({ kill, isAlive }), write: out.write });

    expect(kill).toHaveBeenNthCalledWith(1, 4242, 'SIGTERM');
    expect(kill).toHaveBeenNthCalledWith(2, 4242, 'SIGKILL');
    expect(fs.existsSync(runJsonPath)).toBe(false);
    expect(out.text()).toContain('SIGKILL');
  });

  it('SIGTERM 送信時に ESRCH(既に死亡)でも throw しない', async () => {
    const root = await mkProject();
    writeRunJson(root, { pid: 4242 });
    const kill = vi.fn((_pid: number, _sig: unknown) => {
      const e = new Error('no such process') as NodeJS.ErrnoException;
      e.code = 'ESRCH';
      throw e;
    });
    await expect(
      runStop(makeCtx('stop', root), { ...baseStopDeps({ kill }), write: () => {} }),
    ).resolves.toBeUndefined();
  });

  it('--json: stopped / pid / forced を出力する', async () => {
    const root = await mkProject();
    writeRunJson(root, { pid: 4242 });
    const out = sink();
    await runStop(makeCtx('stop', root, { global: { json: true } }), {
      ...baseStopDeps({ isAlive: vi.fn(() => true), kill: vi.fn() }),
      write: out.write,
    });
    expect(JSON.parse(out.text())).toEqual({ stopped: true, pid: 4242, forced: true });
  });
});

// ─────────────────────────── mnemo status ───────────────────────────

describe('mnemo status', () => {
  function baseStatusDeps(over: Partial<StatusDeps>): Partial<StatusDeps> {
    return {
      detectRunningServer: vi.fn(async () => detection({ running: false })),
      listNotes: vi.fn(async () => ({ notes: [], errors: [] })),
      listSnapshots: vi.fn(async () => []),
      readUsage: vi.fn(async () => ({ records: [], skipped: 0 })),
      readMeta: vi.fn(async () => null),
      ...over,
    };
  }

  it('停止中: 「停止中」と projectRoot を表示する', async () => {
    const root = await mkProject();
    const out = sink();
    await runStatus(makeCtx('status', root), { ...baseStatusDeps({}), write: out.write });
    expect(out.text()).toContain('停止中');
    expect(out.text()).toContain(`projectRoot: ${root}`);
    expect(out.text()).toContain('インデックス: 未構築');
  });

  it('稼働中: pid / port / URL とノート件数・スナップショット数・直近利用日を表示する', async () => {
    const root = await mkProject();
    const out = sink();
    await runStatus(makeCtx('status', root), {
      ...baseStatusDeps({
        detectRunningServer: vi.fn(async () => detection({ running: true, port: 7788, pid: 999 })),
        listNotes: vi.fn(async () => ({
          notes: [
            { id: 'a', absPath: '/x/a.md', relPath: 'knowledge/a.md', fm: {} },
            { id: 'b', absPath: '/x/b.md', relPath: 'knowledge/b.md', fm: {} },
          ] as never,
          errors: [],
        })),
        listSnapshots: vi.fn(async () => [{ id: 's1', label: 'organize', createdAt: 'x', fileCount: 3 }]),
        readUsage: vi.fn(async () => ({
          records: [
            { v: 1, ts: '2026-09-01T00:00:00+09:00', mode: 'store', event: 'store.apply', ok: true },
            { v: 1, ts: '2026-09-02T12:00:00+09:00', mode: 'show', event: 'show.open', ok: true },
          ] as never,
          skipped: 0,
        })),
      }),
      write: out.write,
    });
    const t = out.text();
    expect(t).toContain('稼働中');
    expect(t).toContain('pid 999');
    expect(t).toContain('port 7788');
    expect(t).toContain('http://127.0.0.1:7788');
    expect(t).toContain('ノート件数: 2');
    expect(t).toContain('スナップショット: 1 件');
    expect(t).toContain('直近利用: 2026-09-02T12:00:00+09:00');
  });

  it('meta.json があり全ノートが未登録なら未反映件数を数える', async () => {
    const root = await mkProject();
    const out = sink();
    await runStatus(makeCtx('status', root, { global: { json: true } }), {
      ...baseStatusDeps({
        listNotes: vi.fn(async () => ({
          notes: [{ id: 'a', absPath: '/x/a.md', relPath: 'knowledge/a.md', fm: {} }] as never,
          errors: [],
        })),
        readMeta: vi.fn(async () => ({ builtAt: '2026-09-01T00:00:00Z', docs: {} })),
      }),
      write: out.write,
    });
    const report = JSON.parse(out.text()) as {
      running: boolean;
      index: { builtAt: string | null; staleCount: number };
      noteCount: number;
      vaultPath: string;
    };
    expect(report.running).toBe(false);
    expect(report.noteCount).toBe(1);
    expect(report.index).toEqual({ builtAt: '2026-09-01T00:00:00Z', staleCount: 1 });
    expect(report.vaultPath).toBe(`${root}/vault`);
  });

  it('--json: 稼働中サーバー情報を含む完全なレポートを出力する', async () => {
    const root = await mkProject();
    const out = sink();
    await runStatus(makeCtx('status', root, { global: { json: true } }), {
      ...baseStatusDeps({
        detectRunningServer: vi.fn(async () => detection({ running: true, port: 7777, pid: 111 })),
      }),
      write: out.write,
    });
    const report = JSON.parse(out.text()) as Record<string, unknown>;
    expect(report.server).toEqual({ pid: 111, port: 7777, url: 'http://127.0.0.1:7777' });
    expect(report).toMatchObject({ running: true, projectRoot: root, snapshotCount: 0, lastUsedAt: null });
  });
});

// ─────────────────────────── mnemo open ───────────────────────────

describe('mnemo open', () => {
  it('稼働中: トークン付き URL をブラウザで開く', async () => {
    const root = await mkProject();
    const open = vi.fn(async () => undefined);
    const out = sink();
    await runOpen(makeCtx('open', root), {
      detectRunningServer: vi.fn(async () => detection({ running: true, port: 7790, token: 'tok-x' })),
      open,
      write: out.write,
      writeErr: () => {},
    });
    expect(open).toHaveBeenCalledWith('http://127.0.0.1:7790/?t=tok-x');
    expect(out.text()).toContain('ブラウザで開きました');
  });

  it('未稼働: `mnemo start` を促す(ブラウザは開かない)', async () => {
    const root = await mkProject();
    const open = vi.fn(async () => undefined);
    const err = sink();
    await runOpen(makeCtx('open', root), {
      detectRunningServer: vi.fn(async () => detection({ running: false })),
      open,
      write: () => {},
      writeErr: err.write,
    });
    expect(open).not.toHaveBeenCalled();
    expect(err.text()).toContain('mnemo start');
  });

  it('ブラウザ起動に失敗しても URL を表示して throw しない', async () => {
    const root = await mkProject();
    const out = sink();
    await runOpen(makeCtx('open', root), {
      detectRunningServer: vi.fn(async () => detection({ running: true, port: 7791, token: 'tok-y' })),
      open: vi.fn(async () => { throw new Error('no browser'); }),
      write: out.write,
      writeErr: out.write,
    });
    expect(out.text()).toContain('http://127.0.0.1:7791/?t=tok-y');
  });

  it('--json: running / url / browserOpened を出力する', async () => {
    const root = await mkProject();
    const out = sink();
    await runOpen(makeCtx('open', root, { global: { json: true } }), {
      detectRunningServer: vi.fn(async () => detection({ running: true, port: 7777, token: 'tok-z' })),
      open: vi.fn(async () => undefined),
      write: out.write,
      writeErr: () => {},
    });
    expect(JSON.parse(out.text())).toEqual({
      running: true,
      url: 'http://127.0.0.1:7777/?t=tok-z',
      browserOpened: true,
    });
  });
});
