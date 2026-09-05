// src/cli/commands/stop.ts — `mnemo stop`(設計 §9-1 / §9-6 / §12-6)。
//
// tmp 側 `run.json` の pid に SIGTERM → 5s 以内に消えなければ SIGKILL →
// `run.json` を削除する。`run.json` が無い(= 起動していない)場合はその旨を伝えて終了。
//
// `process.kill` / pid 生存確認 / 待機はすべて `StopDeps` で注入できる(既定は本物)。
// テストでは実プロセスに一切シグナルを送らない。

import fs from 'node:fs';

import { MnemoError } from '../../core/errors.js';
import { runtimePaths } from '../../core/paths.js';
import type { CliCommandContext } from '../index.js';
import * as ui from '../ui.js';

/** SIGTERM 後に消滅を待つ猶予(設計 §9-1: 5 秒)。 */
export const GRACE_PERIOD_MS = 5_000;
/** 生存ポーリング間隔。 */
export const POLL_INTERVAL_MS = 200;

/** `mnemo stop` の副作用注入ポイント。 */
export interface StopDeps {
  /** `process.kill(pid, signal)` 相当。 */
  kill: (pid: number, signal: NodeJS.Signals | number) => void;
  /** pid が生存しているか。既定は `process.kill(pid, 0)`。 */
  isAlive: (pid: number) => boolean;
  /** 指定 ms 待つ。既定は `setTimeout`。テストは即解決を渡す。 */
  sleep: (ms: number) => Promise<void>;
  gracePeriodMs: number;
  pollIntervalMs: number;
  /** 1 行出力(既定 stdout)。 */
  write: (line: string) => void;
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function resolveDeps(over?: Partial<StopDeps>): StopDeps {
  return {
    kill: (pid: number, signal: NodeJS.Signals | number) => {
      process.kill(pid, signal);
    },
    isAlive: defaultIsAlive,
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    gracePeriodMs: GRACE_PERIOD_MS,
    pollIntervalMs: POLL_INTERVAL_MS,
    write: (line: string) => process.stdout.write(`${line}\n`),
    ...over,
  };
}

interface RunJsonShape {
  pid?: unknown;
  port?: unknown;
}

async function readPid(runJsonPath: string): Promise<number | null> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(runJsonPath, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as RunJsonShape;
    if (typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0) {
      return parsed.pid;
    }
  } catch {
    /* 破損 → pid 不明扱い */
  }
  return null;
}

function isMissingProcess(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ESRCH';
}

export async function run(
  ctx: CliCommandContext,
  over?: Partial<StopDeps>,
): Promise<void> {
  const deps = resolveDeps(over);
  const projectRoot = ctx.projectRoot;
  if (projectRoot === undefined) {
    throw new MnemoError('NOT_INITIALIZED', 'projectRoot を解決できませんでした');
  }
  const { json, quiet } = ctx.global;
  const runJsonPath = runtimePaths(projectRoot).runJson;

  const pid = await readPid(runJsonPath);
  if (pid === null) {
    // run.json 無し / 破損。念のため掃除して「起動していません」。
    await fs.promises.rm(runJsonPath, { force: true }).catch(() => {});
    if (json) {
      deps.write(JSON.stringify({ stopped: false, running: false }));
    } else {
      deps.write(ui.info('サーバーは起動していません。'));
    }
    return;
  }

  // SIGTERM。既に死んでいれば ESRCH を許容する。
  try {
    deps.kill(pid, 'SIGTERM');
  } catch (err) {
    if (!isMissingProcess(err)) {
      throw err;
    }
  }

  // 生存ポーリング(壁時計ではなく回数で刻む — テストで決定的)。
  const maxPolls = Math.max(1, Math.ceil(deps.gracePeriodMs / deps.pollIntervalMs));
  let alive = deps.isAlive(pid);
  for (let i = 0; i < maxPolls && alive; i += 1) {
    await deps.sleep(deps.pollIntervalMs);
    alive = deps.isAlive(pid);
  }

  let forced = false;
  if (alive) {
    forced = true;
    try {
      deps.kill(pid, 'SIGKILL');
    } catch (err) {
      if (!isMissingProcess(err)) {
        throw err;
      }
    }
    await deps.sleep(deps.pollIntervalMs);
  }

  await fs.promises.rm(runJsonPath, { force: true }).catch(() => {});

  if (json) {
    deps.write(JSON.stringify({ stopped: true, pid, forced }));
  } else if (!quiet) {
    deps.write(
      ui.success(
        `サーバー (pid ${pid}) を停止しました${forced ? '(SIGKILL で強制終了)' : ''}。`,
      ),
    );
  }
}
