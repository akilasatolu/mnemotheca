// test/e2e/shared-machine.test.ts — 設計 §13-16 共有マシン(パーミッション)。
//
// MNEMO_RUNTIME_DIR を他ユーザー可読(0o755)な一時ディレクトリへ向けて:
//   - ensureRuntimeDir → <projectHash>/ が 0700
//   - startServer(serve 等はスタブ)が書く run.json が 0600
// fs.stat の mode を & 0o777 で検証。Windows はパーミッションモデルが違うのでスキップ。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureRuntimeDir, runtimePaths } from '../../src/core/paths.js';
import { startServer, type BootDeps, type StartedServer } from '../../src/server/boot.js';
import { withRuntimeDir, type RuntimeDirHandle } from '../helpers/runtime.js';
import { cleanupRoots, makeTrackedProject } from '../helpers/e2e.js';

const isWin = process.platform === 'win32';
const d = isWin ? describe.skip : describe;

let rt: RuntimeDirHandle | undefined;
const servers: StartedServer[] = [];

beforeEach(() => {
  // 他ユーザー可読の共有ディレクトリを模す(0o755)。
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemo-shared-'));
  fs.chmodSync(shared, 0o755);
  rt = withRuntimeDir(shared);
});

afterEach(async () => {
  for (const s of servers.splice(0)) {
    try {
      await s.stop();
    } catch {
      /* noop */
    }
  }
  rt?.restore();
  rt = undefined;
  cleanupRoots();
  vi.restoreAllMocks();
});

/** 実 listen / 実 watcher / 実プロセス操作を避けた最小 BootDeps。ensureRuntimeDir / runtimePaths は実物。 */
function bootDeps(): { deps: Partial<BootDeps> } {
  const fakeServer = { close: vi.fn((cb?: () => void) => cb?.()) };
  const watcher = {
    close: vi.fn(async () => undefined),
    onIndexUpdated: vi.fn(() => () => undefined),
    isDown: vi.fn(() => false),
    isPolling: vi.fn(() => false),
  };
  return {
    deps: {
      serve: vi.fn(() => fakeServer) as unknown as BootDeps['serve'],
      createWatcher: vi.fn(() => watcher) as unknown as BootDeps['createWatcher'],
      repairUsageTail: vi.fn(async () => ({ trimmed: false })) as unknown as BootDeps['repairUsageTail'],
      isPortFree: vi.fn(async () => true),
      probeHealthz: vi.fn(async () => false),
      isPidAlive: vi.fn(() => true),
      now: () => new Date('2026-09-03T00:00:00.000Z'),
      pid: 4242,
      version: '9.9.9',
      selfCheckIntervalMs: 30_000,
      exit: vi.fn(),
      logger: vi.fn(),
    },
  };
}

d('§13-16 shared-machine: ランタイム領域のパーミッション', () => {
  it('ensureRuntimeDir が作る <projectHash>/ は 0700', async () => {
    const root = await makeTrackedProject();
    const dir = await ensureRuntimeDir(root);
    expect(dir).toBe(runtimePaths(root).dir);
    const st = await fs.promises.stat(dir);
    expect(st.mode & 0o777).toBe(0o700);
    // base(共有ディレクトリ)は 0o755 のままでも、プロジェクトスロットだけは 0700。
    const base = runtimePaths(root).base;
    expect((await fs.promises.stat(base)).mode & 0o777).toBe(0o755);
  });

  it('startServer が書く run.json は 0600、親スロットは 0700', async () => {
    const root = await makeTrackedProject();
    const { deps } = bootDeps();
    const s = await startServer({ projectRoot: root, detached: true, deps });
    servers.push(s);

    const { runJson, dir } = runtimePaths(root);
    expect(fs.existsSync(runJson)).toBe(true);
    expect((await fs.promises.stat(runJson)).mode & 0o777).toBe(0o600);
    expect((await fs.promises.stat(dir)).mode & 0o777).toBe(0o700);

    const parsed = JSON.parse(fs.readFileSync(runJson, 'utf8')) as { projectRoot: string; token: string };
    expect(parsed.projectRoot).toBe(root);
    expect(typeof parsed.token).toBe('string');
  });

  it('既存 run.json 上書き時も 0600 が維持される', async () => {
    const root = await makeTrackedProject();
    const { runJson, dir } = runtimePaths(root);
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(runJson, '{"stale":true}', { mode: 0o644 });
    await fs.promises.chmod(runJson, 0o644);

    const { deps } = bootDeps();
    const s = await startServer({ projectRoot: root, detached: false, deps });
    servers.push(s);

    expect((await fs.promises.stat(runJson)).mode & 0o777).toBe(0o600);
  });
});
