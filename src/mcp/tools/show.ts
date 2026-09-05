// src/mcp/tools/show.ts — `mnemo_show`(ローカル UI サーバーの検出/起動 + ブラウザ起動)。設計 §8-O / §12-5 / §12-6。
//
// 1. `checkVault(projectRoot)` で vault/ 到達性を確認(NG → VAULT_UNAVAILABLE / VAULT_NOT_WRITABLE)。
// 2. tmp 側 `run.json` + pid 生存 + `GET /healthz` の projectRoot 一致(= `detectRunningServer`)で
//    稼働中サーバーを検出できたら **起動せず** その URL(トークン付き)を返す。
// 3. 未稼働 / pid 死亡 / projectRoot 不一致 → stale 掃除して `withLock(projectRoot, 'run')` 内で
//    `dist/server/boot.js` を detached spawn。ロック取得後にもう一度 `detectRunningServer` で
//    ダブルチェック(並行 show でも 1 つだけ起動)。
// 4. `/healthz` を最大 10s ポーリング(既定間隔 300ms)。無応答 / 子プロセス早期終了 →
//    子へ SIGKILL + run.json 掃除して `SERVER_START_TIMEOUT`。
// 5. `open`(npm パッケージ)でブラウザ起動。失敗しても致命的でなく `browserOpened:false` + URL は返す
//    (`BROWSER_OPEN_FAILED` は throw しない。設計 §8-O)。
//
// `spawn` / `open` / healthz `fetch` / `process.kill` はすべて `ShowDeps` で注入可能(既定は本物)。
// このモジュールは `ToolModule` を **default export** する(結線は registry.ts)。

import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';
import open from 'open';

import { MnemoError } from '../../core/errors.js';
import { withLock } from '../../core/lock.js';
import { ensureRuntimeDir, runtimePaths } from '../../core/paths.js';
import { appendUsage } from '../../core/usage-log.js';
import { checkVault } from '../../core/vault-check.js';
import { detectRunningServer } from '../reindex-client.js';
import type { FetchLike, RunInfo } from '../reindex-client.js';
import { formatShowResult } from '../format.js';
import type { CallToolResult, ToolContext, ToolModule } from './types.js';

// ───────────────────────── inputSchema / 戻り値(設計 §8-O)─────────────────────────

export const ShowInputSchema = z.object({});

export interface ShowOutcome {
  /** `http://127.0.0.1:<port>/?t=<token>`。 */
  url: string;
  /** この呼び出しで新規 spawn したか。既存サーバー利用なら false。 */
  started: boolean;
  /** `open` に成功したか。失敗しても URL は返す。 */
  browserOpened: boolean;
  port: number;
}

export const SHOW_DESCRIPTION =
  'ユーザーが『UI を開いて』『ダッシュボードを見せて』『ブラウザで見たい』『Web 画面を出して』等、' +
  'ローカルの閲覧 UI を開くよう指示したときに呼ぶ。projectRoot 専用のローカル HTTP サーバー' +
  '(127.0.0.1 バインド。未起動なら自動でバックグラウンド起動)を用意し、その URL を既定ブラウザで開く。' +
  'ブラウザを自動で開けなかった場合も URL を返すので、その URL をユーザーに伝えること。';

// ───────────────────────── 依存注入(ShowDeps)─────────────────────────

/** `spawn` / `open` / healthz `fetch` / `process.kill` の注入ポイント。既定はすべて本物。 */
export interface ShowDeps {
  /** `dist/server/boot.js` を起動する。既定 `child_process.spawn`。 */
  spawn: typeof nodeSpawn;
  /** ブラウザで URL を開く。既定 `open`(npm)。 */
  open: (target: string) => Promise<unknown>;
  /** healthz プローブ用 `fetch`。`detectRunningServer` に渡す。既定 `globalThis.fetch`。 */
  fetch: FetchLike;
  /** `process.kill` 相当。起動失敗時の子プロセス SIGKILL に使う。 */
  kill: (pid: number, signal?: NodeJS.Signals | number) => void;
  /** spawn する boot エントリの絶対パス。既定 `<pkg>/dist/server/boot.js`。 */
  bootEntry: string;
  /** healthz プローブのタイムアウト(ms)。既定 800。 */
  healthzTimeoutMs: number;
  /** 起動ポーリングの全体タイムアウト(ms)。既定 10_000(設計 §12-5)。 */
  startTimeoutMs: number;
  /** 起動ポーリングの間隔(ms)。既定 300。 */
  pollIntervalMs: number;
}

/** `src` 実行時は `src/server/boot.js`、`dist` 実行時は `dist/server/boot.js` を指す。 */
function defaultBootEntry(): string {
  return fileURLToPath(new URL('../../server/boot.js', import.meta.url));
}

function resolveDeps(over?: Partial<ShowDeps>): ShowDeps {
  return {
    spawn: nodeSpawn,
    open: (target: string) => open(target),
    fetch: (globalThis.fetch ? globalThis.fetch.bind(globalThis) : (undefined as unknown)) as FetchLike,
    kill: (pid: number, signal?: NodeJS.Signals | number) => {
      process.kill(pid, signal);
    },
    bootEntry: defaultBootEntry(),
    healthzTimeoutMs: 800,
    startTimeoutMs: 10_000,
    pollIntervalMs: 300,
    ...over,
  };
}

// ───────────────────────── ヘルパ ─────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function vaultError(reason: string | undefined): MnemoError {
  if (reason === 'vault-not-writable') {
    return new MnemoError('VAULT_NOT_WRITABLE', 'vault/ に書き込めません', { reason });
  }
  return new MnemoError('VAULT_UNAVAILABLE', 'vault/ にアクセスできません', {
    reason: reason ?? 'unknown',
  });
}

function tokenUrl(run: RunInfo): string {
  return `http://127.0.0.1:${run.port}/?t=${run.token}`;
}

/** 起動失敗時: 子プロセスと(判れば)run.json 記載 pid を SIGKILL する。 */
function killChild(child: ChildProcess, runPath: string, deps: ShowDeps): void {
  try {
    child.kill('SIGKILL');
  } catch {
    /* すでに死んでいる等。無視。 */
  }
  try {
    const raw = fs.readFileSync(runPath, 'utf8');
    const pid = (JSON.parse(raw) as { pid?: unknown }).pid;
    if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) {
      deps.kill(pid, 'SIGKILL');
    }
  } catch {
    /* run.json 無し / 破損 / kill 失敗。無視。 */
  }
}

interface DetectDeps {
  fetch: FetchLike;
  healthzTimeoutMs: number;
}

/**
 * `dist/server/boot.js` を detached 起動し、`/healthz` が応答するまでポーリングする。
 * タイムアウト / 子プロセス早期終了 → SIGKILL + run.json 掃除して `SERVER_START_TIMEOUT`。
 */
async function spawnAndWait(
  projectRoot: string,
  runPath: string,
  deps: ShowDeps,
  detectDeps: DetectDeps,
): Promise<RunInfo> {
  const child = deps.spawn(process.execPath, [deps.bootEntry], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, MNEMO_PROJECT: projectRoot, MNEMO_DETACHED: '1' },
  });
  child.unref();

  // オブジェクト経由にして CFA による過剰な never 絞り込みを避ける。
  const watch: { exited: { code: number | null; signal: NodeJS.Signals | null } | null } = {
    exited: null,
  };
  child.on('error', () => {
    watch.exited = { code: -1, signal: null };
  });
  child.on('exit', (code, signal) => {
    watch.exited = { code, signal };
  });

  const deadline = Date.now() + deps.startTimeoutMs;
  for (;;) {
    const d = await detectRunningServer(projectRoot, detectDeps);
    if (d.running && d.run) {
      return d.run;
    }
    // 子プロセスが 0 以外で終了 = boot の起動失敗(全ポート枯渇 = PORT_UNAVAILABLE 等)。
    // detached + `stdio:'ignore'` のため boot 側の ErrorCode は伝播できず、
    // ここでは一律 SERVER_START_TIMEOUT に丸める(PORT_UNAVAILABLE 自体は boot の単体テスト範囲)。
    const childFailed = watch.exited !== null && watch.exited.code !== 0;
    if (childFailed || Date.now() >= deadline) {
      killChild(child, runPath, deps);
      await fs.promises.rm(runPath, { force: true }).catch(() => {});
      throw new MnemoError(
        'SERVER_START_TIMEOUT',
        'UI サーバーを起動できませんでした。projectRoot 内で `mnemo start` を実行してください',
        watch.exited === null
          ? {}
          : { childExitCode: watch.exited.code, childSignal: watch.exited.signal },
      );
    }
    await delay(deps.pollIntervalMs);
  }
}

// ───────────────────────── 本体 ─────────────────────────

/**
 * `mnemo_show` の中核。テストは `over` で全副作用(spawn / open / fetch / kill / タイムアウト)を注入する。
 */
export async function runShow(projectRoot: string, over?: Partial<ShowDeps>): Promise<ShowOutcome> {
  const deps = resolveDeps(over);

  const vault = await checkVault(projectRoot);
  if (!vault.ok) {
    throw vaultError(vault.reason);
  }

  await ensureRuntimeDir(projectRoot); // 失敗で RUNTIME_DIR_UNWRITABLE(そのまま伝播)
  const runPath = runtimePaths(projectRoot).runJson;
  const detectDeps: DetectDeps = {
    fetch: deps.fetch,
    healthzTimeoutMs: deps.healthzTimeoutMs,
  };

  // 1. 既存サーバーの検出(run.json + pid + healthz projectRoot 一致)。
  const detection = await detectRunningServer(projectRoot, detectDeps);
  let run: RunInfo | null = detection.running ? detection.run : null;
  let started = false;

  // 2. 未稼働なら stale を掃除して withLock('run') 内で detached spawn。
  if (!run) {
    await fs.promises.rm(runPath, { force: true }).catch(() => {});

    const locked = await withLock(projectRoot, 'run', async () => {
      // ロック取得後に再検出(並行 show 対策のダブルチェック)。
      const again = await detectRunningServer(projectRoot, detectDeps);
      if (again.running && again.run) {
        return { run: again.run, started: false };
      }
      const spawned = await spawnAndWait(projectRoot, runPath, deps, detectDeps);
      return { run: spawned, started: true };
    });
    run = locked.run;
    started = locked.started;
  }

  // 3. URL(トークン付き)。
  const url = tokenUrl(run);

  // 4. ブラウザ起動(失敗は致命的でない)。
  let browserOpened = false;
  try {
    await deps.open(url);
    browserOpened = true;
  } catch {
    browserOpened = false;
  }

  // 5. usage_log(失敗しても show は成功扱い)。
  await appendUsage(projectRoot, {
    ts: new Date().toISOString(),
    mode: 'show',
    event: 'show.open',
    ok: true,
  }).catch(() => {});

  return { url, started, browserOpened, port: run.port };
}

// ───────────────────────── ToolModule ─────────────────────────

/** `over` を注入した `ToolModule` を作る(既定モジュールは注入なし)。テストから利用。 */
export function createShowModule(over?: Partial<ShowDeps>): ToolModule {
  return {
    name: 'mnemo_show',
    config: {
      title: 'ローカル UI をブラウザで開く',
      description: SHOW_DESCRIPTION,
      inputSchema: ShowInputSchema,
    },
    handler: async (_args: unknown, ctx: ToolContext): Promise<CallToolResult> => {
      const outcome = await runShow(ctx.projectRoot, over);
      return {
        content: [{ type: 'text' as const, text: formatShowResult(outcome) }],
        structuredContent: {
          url: outcome.url,
          started: outcome.started,
          browserOpened: outcome.browserOpened,
          port: outcome.port,
        },
      };
    },
  };
}

const showModule: ToolModule = createShowModule();

export default showModule;
