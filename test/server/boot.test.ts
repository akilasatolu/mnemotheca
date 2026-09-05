// test/server/boot.test.ts — 設計 §9-6 / §12-5 / §12-6 / §10-3 / §13-12(boot)。
//
// serve / watcher / loadIndex / probeHealthz / isPortFree / process 操作は注入で差し替える。
// ランタイムディレクトリと run.json は実ファイル(makeProject でテストごとに projectHash 分離)。

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  entryProjectRootFromEnv,
  startFromEnv,
  startServer,
  PORT_RANGE_START,
  PORT_RANGE_END,
  type BootDeps,
  type RunJson,
  type StartedServer,
} from '../../src/server/boot.js';
import {
  ensureRuntimeDir as realEnsureRuntimeDir,
  runtimePaths,
} from '../../src/core/paths.js';
import { isMnemoError, MnemoError } from '../../src/core/errors.js';
import { makeProject } from '../helpers/project.js';

const roots: string[] = [];
const started: StartedServer[] = [];

async function project(): Promise<string> {
  const root = await makeProject();
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const s of started.splice(0)) {
    try {
      await s.stop();
    } catch {
      /* noop */
    }
  }
  for (const root of roots.splice(0)) {
    try {
      fs.rmSync(runtimePaths(root).dir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

interface FakeServer {
  close: ReturnType<typeof vi.fn>;
}

function makeDeps(over: Partial<BootDeps> = {}): {
  deps: Partial<BootDeps>;
  serve: ReturnType<typeof vi.fn>;
  server: FakeServer;
  createWatcher: ReturnType<typeof vi.fn>;
  watcher: { close: ReturnType<typeof vi.fn> };
  exit: ReturnType<typeof vi.fn>;
  logger: ReturnType<typeof vi.fn>;
  loadIndex: ReturnType<typeof vi.fn>;
  repairUsageTail: ReturnType<typeof vi.fn>;
} {
  const server: FakeServer = { close: vi.fn((cb?: () => void) => cb?.()) };
  const serve = vi.fn(() => server);
  const watcher = {
    close: vi.fn(async () => undefined),
    onIndexUpdated: vi.fn(() => () => undefined),
    isDown: vi.fn(() => false),
    isPolling: vi.fn(() => false),
  };
  const createWatcher = vi.fn(() => watcher);
  const exit = vi.fn();
  const logger = vi.fn();
  const loadIndex = vi.fn(async () => ({}) as never);
  const repairUsageTail = vi.fn(async () => ({ trimmed: false }));

  const deps: Partial<BootDeps> = {
    serve: serve as unknown as BootDeps['serve'],
    createWatcher: createWatcher as unknown as BootDeps['createWatcher'],
    loadIndex: loadIndex as unknown as BootDeps['loadIndex'],
    repairUsageTail: repairUsageTail as unknown as BootDeps['repairUsageTail'],
    ensureRuntimeDir: realEnsureRuntimeDir,
    isPortFree: vi.fn(async () => true),
    probeHealthz: vi.fn(async () => false),
    probeHealthzStartedAt: vi.fn(async () => null),
    isPidAlive: vi.fn(() => true),
    now: () => new Date('2026-09-03T00:00:00.000Z'),
    pid: 424242,
    version: '9.9.9',
    selfCheckIntervalMs: 30_000,
    exit,
    logger,
    ...over,
  };
  return { deps, serve, server, createWatcher, watcher, exit, logger, loadIndex, repairUsageTail };
}

function readRunJson(root: string): RunJson {
  return JSON.parse(fs.readFileSync(runtimePaths(root).runJson, 'utf8')) as RunJson;
}

async function start(root: string, over: Partial<BootDeps> = {}, opts: { detached?: boolean; port?: number } = {}): Promise<{
  s: StartedServer;
  h: ReturnType<typeof makeDeps>;
}> {
  const h = makeDeps(over);
  const s = await startServer({ projectRoot: root, detached: opts.detached ?? true, port: opts.port, deps: h.deps });
  started.push(s);
  return { s, h };
}

// ---------------------------------------------------------------------------
describe('startServer — 正常起動', () => {
  it('ポート確保・token 生成・run.json(§10-3 スキーマ / mode 0600)・watcher・serve', async () => {
    const root = await project();
    const { s, h } = await start(root);

    expect(s.port).toBeGreaterThanOrEqual(PORT_RANGE_START);
    expect(s.port).toBeLessThanOrEqual(PORT_RANGE_END);
    expect(s.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(s.token.length).toBeGreaterThanOrEqual(32);

    // serve は 127.0.0.1 バインド。
    expect(h.serve).toHaveBeenCalledTimes(1);
    const serveArg = h.serve.mock.calls[0]![0] as { hostname?: string; port?: number; fetch?: unknown };
    expect(serveArg.hostname).toBe('127.0.0.1');
    expect(serveArg.port).toBe(s.port);
    expect(typeof serveArg.fetch).toBe('function');

    // watcher は loadIndex のハンドルで起動。
    expect(h.loadIndex).toHaveBeenCalledWith(root);
    expect(h.createWatcher).toHaveBeenCalledTimes(1);
    expect(h.repairUsageTail).toHaveBeenCalledWith(root);

    // run.json スキーマ厳密(キー 8 個ちょうど・順序どおり)。
    const runPath = runtimePaths(root).runJson;
    const run = readRunJson(root);
    expect(Object.keys(run)).toEqual([
      'v',
      'pid',
      'port',
      'token',
      'startedAt',
      'projectRoot',
      'version',
      'detached',
    ]);
    expect(run).toEqual({
      v: 1,
      pid: 424242,
      port: s.port,
      token: s.token,
      startedAt: '2026-09-03T00:00:00.000Z',
      projectRoot: root,
      version: '9.9.9',
      detached: true,
    });

    // mode 0600。
    expect(fs.statSync(runPath).mode & 0o777).toBe(0o600);
  });

  it('detached:false は run.json に反映される', async () => {
    const root = await project();
    await start(root, {}, { detached: false });
    expect(readRunJson(root).detached).toBe(false);
  });

  it('repairUsageTail が throw しても起動は継続する', async () => {
    const root = await project();
    const repairUsageTail = vi.fn(async () => {
      throw new Error('boom');
    });
    const { s, h } = await start(root, { repairUsageTail: repairUsageTail as unknown as BootDeps['repairUsageTail'] });
    expect(s.port).toBeGreaterThanOrEqual(PORT_RANGE_START);
    expect(h.serve).toHaveBeenCalled();
    expect(h.logger).toHaveBeenCalled();
  });

  it('loadIndex が throw しても HTTP 本体は起動する(watcher なし)', async () => {
    const root = await project();
    const loadIndex = vi.fn(async () => {
      throw new MnemoError('INDEX_BUILD_FAILED', 'x');
    });
    const { s, h } = await start(root, { loadIndex: loadIndex as unknown as BootDeps['loadIndex'] });
    expect(s.port).toBeGreaterThanOrEqual(PORT_RANGE_START);
    expect(h.createWatcher).not.toHaveBeenCalled();
    expect(h.serve).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('startServer — ポート確保(§12-5)', () => {
  it('7777 占有 → 7778 で起動、run.json に記録', async () => {
    const root = await project();
    const isPortFree = vi.fn(async (p: number) => p !== PORT_RANGE_START);
    const { s } = await start(root, { isPortFree: isPortFree as unknown as BootDeps['isPortFree'] });
    expect(s.port).toBe(PORT_RANGE_START + 1);
    expect(readRunJson(root).port).toBe(PORT_RANGE_START + 1);
  });

  it('全レンジ占有 → PORT_UNAVAILABLE', async () => {
    const root = await project();
    const h = makeDeps({ isPortFree: (async () => false) as unknown as BootDeps['isPortFree'] });
    await expect(startServer({ projectRoot: root, detached: true, deps: h.deps })).rejects.toSatisfy(
      (e: unknown) => isMnemoError(e) && e.code === 'PORT_UNAVAILABLE',
    );
    expect(h.serve).not.toHaveBeenCalled();
  });

  it('--port 明示 かつ 占有 → 自動ずらしせず即 PORT_UNAVAILABLE', async () => {
    const root = await project();
    const isPortFree = vi.fn(async (p: number) => p !== 9999);
    const h = makeDeps({ isPortFree: isPortFree as unknown as BootDeps['isPortFree'] });
    await expect(
      startServer({ projectRoot: root, detached: true, port: 9999, deps: h.deps }),
    ).rejects.toSatisfy((e: unknown) => isMnemoError(e) && e.code === 'PORT_UNAVAILABLE');
    // 明示ポートだけを試し、レンジ探索しない。
    expect(isPortFree).toHaveBeenCalledTimes(1);
    expect(isPortFree).toHaveBeenCalledWith(9999);
  });

  it('--port 明示 かつ 空き → そのポートで起動', async () => {
    const root = await project();
    const { s } = await start(root, {}, { port: 8123 });
    expect(s.port).toBe(8123);
    expect(readRunJson(root).port).toBe(8123);
  });
});

// ---------------------------------------------------------------------------
describe('startServer — 多重起動ガード(§12-5)', () => {
  it('run.json 生存 & pid 生存 & healthz projectRoot 一致 → 起動せず既存 port/token を返す', async () => {
    const root = await project();
    await realEnsureRuntimeDir(root);
    const existing: RunJson = {
      v: 1,
      pid: 55,
      port: 7788,
      token: 'existing-token',
      startedAt: '2026-09-01T00:00:00.000Z',
      projectRoot: root,
      version: '1.0.0',
      detached: true,
    };
    fs.writeFileSync(runtimePaths(root).runJson, JSON.stringify(existing));

    const { s, h } = await start(root, {
      isPidAlive: (() => true) as unknown as BootDeps['isPidAlive'],
      probeHealthz: (async () => true) as unknown as BootDeps['probeHealthz'],
    });
    expect(s.port).toBe(7788);
    expect(s.token).toBe('existing-token');
    expect(h.serve).not.toHaveBeenCalled();
    expect(h.createWatcher).not.toHaveBeenCalled();
  });

  it('run.json あるが pid 死亡 → 新規起動', async () => {
    const root = await project();
    await realEnsureRuntimeDir(root);
    fs.writeFileSync(
      runtimePaths(root).runJson,
      JSON.stringify({ v: 1, pid: 999999, port: 7788, token: 't', projectRoot: root }),
    );
    const { s, h } = await start(root, {
      isPidAlive: (() => false) as unknown as BootDeps['isPidAlive'],
    });
    expect(h.serve).toHaveBeenCalled();
    expect(s.token).not.toBe('t');
  });

  it('run.json あり pid 生存だが healthz projectRoot 不一致(stale)→ 新規起動', async () => {
    const root = await project();
    await realEnsureRuntimeDir(root);
    fs.writeFileSync(
      runtimePaths(root).runJson,
      JSON.stringify({ v: 1, pid: 55, port: 7788, token: 't', projectRoot: root }),
    );
    const { h } = await start(root, {
      isPidAlive: (() => true) as unknown as BootDeps['isPidAlive'],
      probeHealthz: (async () => false) as unknown as BootDeps['probeHealthz'],
    });
    expect(h.serve).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('startServer — stop / SIGTERM(§13-12)', () => {
  it('stop() → run.json 削除・watcher close・server close(冪等)', async () => {
    const root = await project();
    const { s, h } = await start(root);
    const runPath = runtimePaths(root).runJson;
    expect(fs.existsSync(runPath)).toBe(true);

    await s.stop();
    expect(fs.existsSync(runPath)).toBe(false);
    expect(h.watcher.close).toHaveBeenCalledTimes(1);
    expect(h.server.close).toHaveBeenCalledTimes(1);

    // 冪等。
    await s.stop();
    expect(h.watcher.close).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
describe('startServer — 2 プロジェクト同時(§13-12)', () => {
  it('別 projectRoot → 別ポート・別 run.json', async () => {
    const rootA = await project();
    const rootB = await project();
    const claimed = new Set<number>();
    const isPortFree = (async (p: number) => !claimed.has(p)) as unknown as BootDeps['isPortFree'];

    const a = await start(rootA, { isPortFree });
    claimed.add(a.s.port);
    const b = await start(rootB, { isPortFree });

    expect(a.s.port).not.toBe(b.s.port);
    expect(runtimePaths(rootA).runJson).not.toBe(runtimePaths(rootB).runJson);
    expect(readRunJson(rootA).projectRoot).toBe(rootA);
    expect(readRunJson(rootB).projectRoot).toBe(rootB);
    expect(readRunJson(rootA).port).toBe(a.s.port);
    expect(readRunJson(rootB).port).toBe(b.s.port);
  });
});

// ---------------------------------------------------------------------------
describe('selfCheckTick — 一時領域クリア耐性 N-4(§12-6 / §13-12)', () => {
  it('run.json 外部削除 → 同じ pid/port/token で再生成(自殺しない)', async () => {
    const root = await project();
    const { s, h } = await start(root);
    const before = readRunJson(root);
    const runPath = runtimePaths(root).runJson;

    fs.rmSync(runPath);
    expect(fs.existsSync(runPath)).toBe(false);

    await s.selfCheckTick();

    expect(fs.existsSync(runPath)).toBe(true);
    const after = readRunJson(root);
    expect(after).toEqual(before);
    expect(h.exit).not.toHaveBeenCalled();
  });

  it('run.json の pid が別値・別サーバーは不在 → 自殺せず run.json を奪還する(孤児化耐性)', async () => {
    const root = await project();
    // 自ポートには自分しかいない(他サーバー不在)。
    const { s, h } = await start(root, { probeHealthzStartedAt: vi.fn(async () => null) });
    const runPath = runtimePaths(root).runJson;
    const mine = readRunJson(root);

    fs.writeFileSync(runPath, JSON.stringify({ ...mine, pid: 111111, token: 'stale-token' }));

    await s.selfCheckTick();

    expect(h.exit).not.toHaveBeenCalled();
    expect(h.watcher.close).not.toHaveBeenCalled();
    // run.json は自分の pid/token に戻っている。
    expect(readRunJson(root)).toEqual(mine);
  });

  it('run.json を別ポートの生きたサーバーが引き継いだ → graceful shutdown(run.json は消さない)', async () => {
    const root = await project();
    const { s, h } = await start(root, {
      // run.json が指すポートに、自分とは別の startedAt のサーバーが応答する。
      probeHealthzStartedAt: vi.fn(async () => '2099-01-01T00:00:00.000Z'),
    });
    const runPath = runtimePaths(root).runJson;
    const taken = { ...readRunJson(root), pid: 111111, port: 7778 };
    fs.writeFileSync(runPath, JSON.stringify(taken));

    await s.selfCheckTick();

    expect(h.watcher.close).toHaveBeenCalledTimes(1);
    expect(h.server.close).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledWith(0);
    expect(fs.existsSync(runPath)).toBe(true);
    expect(readRunJson(root).pid).toBe(111111);
  });

  it('run.json の projectRoot が化けた・別サーバー不在 → run.json を奪還する', async () => {
    const root = await project();
    const { s, h } = await start(root, { probeHealthzStartedAt: vi.fn(async () => null) });
    const runPath = runtimePaths(root).runJson;
    const mine = readRunJson(root);
    fs.writeFileSync(runPath, JSON.stringify({ ...mine, projectRoot: '/somewhere/else' }));

    await s.selfCheckTick();
    expect(h.exit).not.toHaveBeenCalled();
    expect(readRunJson(root)).toEqual(mine);
  });

  it('run.json が自分のもの → mtime が touch される', async () => {
    const root = await project();
    let clock = new Date('2026-09-03T00:00:00.000Z').getTime();
    const now = () => new Date(clock);
    const { s } = await start(root, { now: now as unknown as BootDeps['now'] });
    const runPath = runtimePaths(root).runJson;

    clock = new Date('2030-01-01T00:00:00.000Z').getTime();
    await s.selfCheckTick();

    const mtime = fs.statSync(runPath).mtimeMs;
    expect(Math.abs(mtime - clock)).toBeLessThan(2000);
  });

  it('再生成が 3 連続失敗 → graceful shutdown で exit(0)', async () => {
    const root = await project();
    let calls = 0;
    const ensureRuntimeDir = vi.fn(async (r: string) => {
      calls += 1;
      if (calls > 1) throw new MnemoError('RUNTIME_DIR_UNWRITABLE', 'gone', { base: r });
      return realEnsureRuntimeDir(r);
    });
    const { s, h } = await start(root, {
      ensureRuntimeDir: ensureRuntimeDir as unknown as BootDeps['ensureRuntimeDir'],
    });
    const runPath = runtimePaths(root).runJson;

    for (let i = 0; i < 3; i += 1) {
      fs.rmSync(runPath, { force: true });
      await s.selfCheckTick();
    }
    expect(h.exit).toHaveBeenCalledWith(0);
    expect(h.watcher.close).toHaveBeenCalled();
  });

  it('selfCheckTick は selfCheckIntervalMs 間隔・unref 付きの setInterval で駆動される', async () => {
    const root = await project();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const { s } = await start(root, { selfCheckIntervalMs: 30_000 });

    const call = setIntervalSpy.mock.calls.find((c) => c[1] === 30_000);
    expect(call).toBeDefined();
    const handle = setIntervalSpy.mock.results.at(-1)!.value as ReturnType<typeof setInterval>;
    // unref 済み(プロセスを引き止めない)。
    expect((handle as unknown as { hasRef: () => boolean }).hasRef()).toBe(false);

    await s.stop();
  });

  it('interval コールバックに selfCheckTick 本体が渡っている(手動実行で再生成が走る)', async () => {
    const root = await project();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const { s, h } = await start(root);
    const cb = setIntervalSpy.mock.calls.find((c) => c[1] === 30_000)![0] as () => void;

    fs.rmSync(runtimePaths(root).runJson);
    cb();
    await vi.waitFor(() => {
      expect(fs.existsSync(runtimePaths(root).runJson)).toBe(true);
    });
    expect(h.exit).not.toHaveBeenCalled();
    await s.stop();
  });
});

// ---------------------------------------------------------------------------
describe('直接起動エントリ', () => {
  it('entryProjectRootFromEnv: MNEMO_PROJECT 無し → MnemoError', () => {
    expect(() => entryProjectRootFromEnv({})).toThrow(MnemoError);
    expect(() => entryProjectRootFromEnv({ MNEMO_PROJECT: '' })).toThrow(MnemoError);
  });

  it('entryProjectRootFromEnv: 値あり → そのまま返す', () => {
    expect(entryProjectRootFromEnv({ MNEMO_PROJECT: '/x/y' })).toBe('/x/y');
  });

  it('startFromEnv: MNEMO_PROJECT 無し → reject(直接起動ガードが exit 1 する経路)', async () => {
    await expect(startFromEnv({})).rejects.toBeInstanceOf(MnemoError);
  });

  it('startFromEnv: MNEMO_PORT 不正 → PORT_UNAVAILABLE', async () => {
    const root = await project();
    await expect(startFromEnv({ MNEMO_PROJECT: root, MNEMO_PORT: 'abc' })).rejects.toSatisfy(
      (e: unknown) => isMnemoError(e) && e.code === 'PORT_UNAVAILABLE',
    );
  });
});
