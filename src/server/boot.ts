// src/server/boot.ts — mnemo HTTP サーバーのプロセスエントリ(設計 §9-6 / §12-5 / §12-6 / §10-3)。
//
// CLI(`mnemo start`)は `startServer({ projectRoot, detached: false })` を同一プロセスで呼ぶ。
// MCP(`mnemo_show`)/ CLI は未起動時に `spawn(process.execPath, [dist/server/boot.js],
// { detached: true, stdio: 'ignore', env: { ...process.env, MNEMO_PROJECT, MNEMO_DETACHED: '1' } })`
// で別プロセス起動する。その場合このファイルが直接実行され、末尾の直接起動ガードが
// `MNEMO_PROJECT` を読んで `startServer` を呼ぶ(無ければ exit 1)。
//
// `startServer` は `{ port, token, stop() }` を返すだけで、シグナルハンドラは登録しない
// (テスト容易性)。直接起動ガード側が `SIGTERM` / `SIGINT` を `stop()` にディスパッチする。

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import type { CreateAppDeps } from './app.js';
import { createWatcher } from './watcher.js';
import type { Watcher } from './watcher.js';
import { mountApiRoutes, type OrganizeRecoveryPending } from './mount.js';
import { readIndexMetaFromDisk } from './routes/config.js';
import type { IndexEventPayload } from './routes/events.js';
import { loadIndex, type IndexHandle } from '../core/search.js';
import { repairUsageTail } from '../core/usage-log.js';
import { ensureRuntimeDir, mnemothecaPaths, runtimePaths } from '../core/paths.js';
import { MnemoError } from '../core/errors.js';

/** ポート探索範囲(設計 §12-5)。先頭から `listen` を試す。 */
export const PORT_RANGE_START = 7777;
export const PORT_RANGE_END = 7796;

/** セルフチェック間隔(設計 §12-6: 30 秒)。 */
export const SELF_CHECK_INTERVAL_MS = 30_000;

/** `<runtimeBase>/mnemotheca/<projectHash>/run.json` スキーマ(設計 §10-3。厳密に。余計なフィールドを足さない)。 */
export interface RunJson {
  v: 1;
  pid: number;
  port: number;
  token: string;
  startedAt: string;
  projectRoot: string;
  version: string;
  detached: boolean;
}

/** `startServer` の引数(設計 §9-6)。 */
export interface StartServerOptions {
  /** projectRoot 絶対パス。boot は探索しない(§1-2-1)。 */
  projectRoot: string;
  /** デタッチ起動か(`mnemo_show` 経由 = true / `mnemo start` = false)。run.json に記録。 */
  detached: boolean;
  /** `--port` / `MNEMO_PORT` 明示指定。指定時は自動ずらしをしない(§12-5)。 */
  port?: number;
  /** テスト用の依存差し替え。 */
  deps?: Partial<BootDeps>;
}

/** `startServer` の依存注入ポイント(テストで実 listen / 実 watcher / 実プロセス操作を避ける)。 */
export interface BootDeps {
  serve: typeof serve;
  createApp: typeof createApp;
  createWatcher: typeof createWatcher;
  mountApiRoutes: typeof mountApiRoutes;
  loadIndex: typeof loadIndex;
  repairUsageTail: typeof repairUsageTail;
  ensureRuntimeDir: typeof ensureRuntimeDir;
  runtimePaths: typeof runtimePaths;
  /** `port` が 127.0.0.1 で bind 可能か。既定は `net.createServer().listen`。 */
  isPortFree: (port: number) => Promise<boolean>;
  /** 稼働中サーバーの `/healthz` を叩き projectRoot 一致を確認(多重起動防止。§12-5)。 */
  probeHealthz: (port: number, projectRoot: string) => Promise<boolean>;
  /**
   * `port` の `/healthz` を叩き、`ok` かつ projectRoot 一致なら `startedAt` を返す(不一致 / 無応答 → null)。
   * セルフチェックが「run.json のスロットを引き継いだのは *別の生きたサーバー* か、それとも
   * 単に古い / 巻き戻った run.json なのか」を見分けるのに使う(§12-6)。
   */
  probeHealthzStartedAt: (port: number, projectRoot: string) => Promise<string | null>;
  /** pid が生存しているか。既定は `process.kill(pid, 0)`。 */
  isPidAlive: (pid: number) => boolean;
  now: () => Date;
  pid: number;
  version: string;
  selfCheckIntervalMs: number;
  /** graceful shutdown 後のプロセス終了。既定 `process.exit`。テストでは spy。 */
  exit: (code?: number) => void;
  logger: (msg: string, err?: unknown) => void;
}

/** `startServer` の戻り値(設計 §9-6)。 */
export interface StartedServer {
  port: number;
  token: string;
  /** このサーバーが所有する run.json の絶対パス(直接起動ガードの同期クリーンアップ用)。 */
  runJsonPath: string;
  /** run.json 削除 + watcher close + server close。冪等。 */
  stop(): Promise<void>;
  /**
   * セルフチェック 1 回分(設計 §12-6)。通常は 30s 間隔の `setInterval` から呼ばれるが、
   * テストが `vi.useFakeTimers()` 下で直接呼べるよう公開する。
   */
  selfCheckTick(): Promise<void>;
}

// ---------------------------------------------------------------------------
// 既定の依存実装
// ---------------------------------------------------------------------------

/** `net.createServer().listen(port, '127.0.0.1')` で空きを検出 → 即 close。競合なら false。 */
function defaultIsPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => {
      srv.close(() => resolve(true));
    });
    srv.listen(port, '127.0.0.1');
  });
}

async function defaultProbeHealthz(port: number, projectRoot: string): Promise<boolean> {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 1000);
    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: ac.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return false;
    const body = (await res.json()) as { projectRoot?: unknown };
    return body.projectRoot === projectRoot;
  } catch {
    return false;
  }
}

async function defaultProbeHealthzStartedAt(port: number, projectRoot: string): Promise<string | null> {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 1000);
    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: ac.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return null;
    const body = (await res.json()) as { projectRoot?: unknown; startedAt?: unknown };
    if (body.projectRoot !== projectRoot) return null;
    return typeof body.startedAt === 'string' ? body.startedAt : null;
  } catch {
    return null;
  }
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function defaultVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // dist/server/boot.js → dist/../package.json、src 実行時は src/server → ../../package.json。
    for (const rel of ['../../package.json', '../package.json']) {
      const p = path.join(here, rel);
      if (fs.existsSync(p)) {
        const v = (JSON.parse(fs.readFileSync(p, 'utf8')) as { version?: unknown }).version;
        if (typeof v === 'string') return v;
      }
    }
  } catch {
    /* fallthrough */
  }
  return '0.0.0';
}

function resolveDeps(over?: Partial<BootDeps>): BootDeps {
  return {
    serve,
    createApp,
    createWatcher,
    mountApiRoutes,
    loadIndex,
    repairUsageTail,
    ensureRuntimeDir,
    runtimePaths,
    isPortFree: defaultIsPortFree,
    probeHealthz: defaultProbeHealthz,
    probeHealthzStartedAt: defaultProbeHealthzStartedAt,
    isPidAlive: defaultIsPidAlive,
    now: () => new Date(),
    pid: process.pid,
    version: defaultVersion(),
    selfCheckIntervalMs: SELF_CHECK_INTERVAL_MS,
    exit: (code?: number) => process.exit(code ?? 0),
    // eslint-disable-next-line no-console
    logger: (msg: string, err?: unknown) => console.error(`[mnemo:boot] ${msg}`, err ?? ''),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 内部ヘルパ
// ---------------------------------------------------------------------------

async function writeRunJson(runJsonPath: string, info: RunJson): Promise<void> {
  const data = JSON.stringify(info);
  await fs.promises.writeFile(runJsonPath, data, { mode: 0o600 });
  // 既存ファイル上書き時は writeFile の mode が効かないため明示的に chmod(§8-A / §12-6)。
  await fs.promises.chmod(runJsonPath, 0o600);
}

async function acquirePort(d: BootDeps, explicit: number | undefined): Promise<number> {
  if (explicit !== undefined) {
    if (await d.isPortFree(explicit)) return explicit;
    throw new MnemoError('PORT_UNAVAILABLE', `指定されたポート ${explicit} は使用中です。`, { port: explicit });
  }
  for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p += 1) {
    if (await d.isPortFree(p)) return p;
  }
  throw new MnemoError(
    'PORT_UNAVAILABLE',
    `ポート ${PORT_RANGE_START}–${PORT_RANGE_END} に空きがありません。mnemo start --port <N> で明示指定できます。`,
    { range: [PORT_RANGE_START, PORT_RANGE_END] },
  );
}

/** 既に同一 projectRoot のサーバーが稼働中なら `{ port, token }` を返す(§12-5 多重起動防止)。 */
async function probeExistingServer(
  d: BootDeps,
  runJsonPath: string,
  projectRoot: string,
): Promise<{ port: number; token: string } | null> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(runJsonPath, 'utf8');
  } catch {
    return null;
  }
  let info: Partial<RunJson>;
  try {
    info = JSON.parse(raw) as Partial<RunJson>;
  } catch {
    return null;
  }
  if (typeof info.pid !== 'number' || typeof info.port !== 'number' || typeof info.token !== 'string') {
    return null;
  }
  if (!d.isPidAlive(info.pid)) return null;
  if (!(await d.probeHealthz(info.port, projectRoot))) return null;
  return { port: info.port, token: info.token };
}

/**
 * `organize-session.json` を **読み取り専用**で調べ、中断 organize(`applying:true` かつ未失効)を
 * 検出する(設計 §12-10 表 #3: boot は「フラグを立てるのみ・ファイルを書き換えない・自動 restore しない」)。
 *
 * - ファイル無し / JSON 破損 / 形不一致 → `null`(破損退避もしない。退避は §8-N scan の責務)。
 * - `applying !== true` → `null`。
 * - `expiresAt` がパース可能で `now` がそれを過ぎている → `null`(失効)。
 * - `snapshotId` が文字列でない → `null`(復元先が無いので復帰フラグを立てない)。
 */
async function readOrganizeRecoveryPending(
  projectRoot: string,
  now: number,
): Promise<OrganizeRecoveryPending | null> {
  const file = mnemothecaPaths(projectRoot).organizeSessionJson;
  let raw: string;
  try {
    raw = await fs.promises.readFile(file, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const rec = parsed as Record<string, unknown>;
  if (rec['applying'] !== true) return null;

  const expiresRaw = rec['expiresAt'];
  if (typeof expiresRaw === 'string') {
    const expiresMs = Date.parse(expiresRaw);
    if (!Number.isNaN(expiresMs) && now > expiresMs) return null;
  }

  const snapshotId = rec['snapshotId'];
  if (typeof snapshotId !== 'string' || snapshotId === '') return null;

  const since = typeof rec['scannedAt'] === 'string' ? (rec['scannedAt'] as string) : '';
  return { snapshotId, since };
}

// ---------------------------------------------------------------------------
// startServer
// ---------------------------------------------------------------------------

export async function startServer(opts: StartServerOptions): Promise<StartedServer> {
  const d = resolveDeps(opts.deps);
  const { projectRoot, detached } = opts;
  const runJsonPath = d.runtimePaths(projectRoot).runJson;

  // 1. 多重起動ガード(探索前に run.json + pid + /healthz projectRoot 一致で判定。§12-5)。
  const existing = await probeExistingServer(d, runJsonPath, projectRoot);
  if (existing) {
    d.logger(`既に稼働中のサーバーを検出しました (port ${existing.port})。新規起動しません。`);
    return {
      port: existing.port,
      token: existing.token,
      runJsonPath,
      stop: async () => {},
      selfCheckTick: async () => {},
    };
  }

  // 2. ポート確保。
  const port = await acquirePort(d, opts.port);

  // 3. トークン。
  const token = randomBytes(24).toString('base64url');

  // 4. ランタイムディレクトリ(0o700)。失敗時は MnemoError(RUNTIME_DIR_UNWRITABLE) が伝播する。
  await d.ensureRuntimeDir(projectRoot);

  // 5. usage_log の途中で切れた末尾行を修復(非致命的。§12-6)。
  try {
    await d.repairUsageTail(projectRoot);
  } catch (err) {
    d.logger('usage_log の tail 修復に失敗しました(続行します)', err);
  }

  // 6. tmp 側 run.json 書き込み(mode 0o600、§10-3 スキーマ厳密)。
  const startedAt = d.now().toISOString();
  const runJson: RunJson = {
    v: 1,
    pid: d.pid,
    port,
    token,
    startedAt,
    projectRoot,
    version: d.version,
    detached,
  };
  await writeRunJson(runJsonPath, runJson);

  // 7. watcher 起動 + live インデックスハンドル保持(失敗しても HTTP 本体は落とさない)。
  let liveHandle: IndexHandle | null = null;
  let watcher: Watcher | null = null;
  try {
    liveHandle = await d.loadIndex(projectRoot);
    watcher = d.createWatcher(projectRoot, { handle: liveHandle });
  } catch (err) {
    d.logger('インデックス読み込み / watcher 起動に失敗しました(ファイル監視なしで続行)', err);
  }

  // watcher の単一 `onIndexUpdated` → 複数 SSE クライアントへのファンアウト。
  const sseSubscribers = new Set<(p: IndexEventPayload) => void>();
  if (watcher) {
    watcher.onIndexUpdated((payload) => {
      const event: IndexEventPayload = { type: payload.type, changed: payload.changed };
      for (const cb of [...sseSubscribers]) {
        try {
          cb(event);
        } catch (err) {
          d.logger('SSE 購読コールバックが例外を投げました', err);
        }
      }
    });
  }

  /** live ハンドル(無ければ遅延ロード)。`POST /api/reindex {full:true}` 後は `onRebuilt` で差し替わる。 */
  const getIndex = async (): Promise<IndexHandle> => {
    if (liveHandle) return liveHandle;
    liveHandle = await d.loadIndex(projectRoot);
    return liveHandle;
  };

  // 8. listen。
  const appDeps: CreateAppDeps = { projectRoot, token, port, startedAt, version: d.version };
  const apiRouter = d.mountApiRoutes({
    projectRoot,
    vaultPath: appDeps.vaultPath ?? path.join(projectRoot, 'vault'),
    port,
    startedAt,
    version: d.version,
    token,
    getIndex,
    onRebuilt: (h) => {
      liveHandle = h;
    },
    subscribe: (cb) => {
      sseSubscribers.add(cb);
      return () => sseSubscribers.delete(cb);
    },
    readIndexMeta: async () =>
      liveHandle
        ? { docCount: liveHandle.meta.docCount, builtAt: liveHandle.meta.builtAt }
        : readIndexMetaFromDisk(projectRoot),
    getOrganizeRecoveryPending: () => readOrganizeRecoveryPending(projectRoot, d.now().getTime()),
    watcherIsDown: () => watcher?.isDown() ?? false,
  });
  const app = d.createApp(appDeps, apiRouter);
  const server = d.serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });

  // 9. セルフチェック(§12-6)。
  let stopped = false;
  let consecutiveRegenFailures = 0;

  const cleanup = async (removeRunJson: boolean): Promise<void> => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    if (watcher) {
      try {
        await watcher.close();
      } catch (err) {
        d.logger('watcher close に失敗しました', err);
      }
    }
    await new Promise<void>((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });
    if (removeRunJson) {
      try {
        await fs.promises.rm(runJsonPath, { force: true });
      } catch (err) {
        d.logger('run.json 削除に失敗しました', err);
      }
    }
  };

  const stop = (): Promise<void> => cleanup(true);

  const regenerate = async (): Promise<void> => {
    try {
      await d.ensureRuntimeDir(projectRoot);
      await writeRunJson(runJsonPath, runJson);
      consecutiveRegenFailures = 0;
    } catch (err) {
      consecutiveRegenFailures += 1;
      d.logger(`run.json の再生成に失敗しました(${consecutiveRegenFailures}/3)`, err);
      if (consecutiveRegenFailures >= 3) {
        d.logger('run.json 再生成に 3 連続失敗。graceful shutdown します(mnemo start で復帰可能)。');
        await cleanup(true);
        d.exit(0);
      }
    }
  };

  const selfCheckTick = async (): Promise<void> => {
    if (stopped) return;
    let raw: string;
    try {
      raw = await fs.promises.readFile(runJsonPath, 'utf8');
    } catch {
      // 消えている → OS の一時領域クリア等。自殺せず自分の情報で再生成(§12-6 / N-4)。
      await regenerate();
      return;
    }
    let info: Partial<RunJson>;
    try {
      info = JSON.parse(raw) as Partial<RunJson>;
    } catch {
      await regenerate();
      return;
    }
    if (info.pid !== d.pid || info.projectRoot !== projectRoot) {
      // run.json が自分を指していない。原因は 2 通り:
      //   (a) 別の生きたサーバーが本当にこのプロジェクトを引き継いだ → 自分は古い。step down。
      //   (b) run.json が古い / 巻き戻った / 一時領域クリアで別内容に化けただけで、
      //       このプロジェクトのサーバーは依然として自分 → run.json を奪還する(自殺しない)。
      // 見分け方: run.json が指すポートの /healthz を叩き、そこが「自分の startedAt」でない
      // 別サーバーで、かつ自分の listen ポートと異なるなら (a)。それ以外は (b)。
      // 自分のポートは自分が bind し続けている限り他プロセスは奪えない(§12-5)ので、
      // 自ポートに応答があれば必ず自分 = (b) に倒れる。
      const runPort = typeof info.port === 'number' ? info.port : port;
      const otherStartedAt = await d.probeHealthzStartedAt(runPort, projectRoot);
      const differentLiveServer =
        runPort !== port && otherStartedAt !== null && otherStartedAt !== startedAt;
      if (differentLiveServer) {
        d.logger(
          `run.json を別の稼働サーバー(port ${runPort})が引き継ぎました。graceful shutdown します。`,
        );
        await cleanup(false);
        d.exit(0);
        return;
      }
      d.logger('run.json が古い / 別内容を指していますが、本サーバーは稼働中です。run.json を奪還します。');
      await regenerate();
      return;
    }
    // 自分のもの → mtime を touch(一時領域のアイドルファイル削除ヒューリスティック回避。§12-6)。
    consecutiveRegenFailures = 0;
    const t = d.now();
    try {
      await fs.promises.utimes(runJsonPath, t, t);
    } catch (err) {
      d.logger('run.json の mtime 更新に失敗しました', err);
    }
  };

  const timer: ReturnType<typeof setInterval> = setInterval(() => {
    void selfCheckTick();
  }, d.selfCheckIntervalMs);
  timer.unref();

  return { port, token, runJsonPath, stop, selfCheckTick };
}

// ---------------------------------------------------------------------------
// 直接起動エントリ(spawn される dist/server/boot.js)
// ---------------------------------------------------------------------------

/** `MNEMO_PROJECT` から projectRoot を取り出す。未設定なら即エラー(直接起動ガードが exit 1)。 */
export function entryProjectRootFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const p = env['MNEMO_PROJECT'];
  if (p === undefined || p === '') {
    throw new MnemoError(
      'NOT_INITIALIZED',
      'MNEMO_PROJECT 環境変数が設定されていません。boot は projectRoot を探索しません(spawn 元が渡す必要があります)。',
    );
  }
  return p;
}

/** 環境変数から `startServer` の引数を組み立てて起動する(直接起動 / テスト双方から使える)。 */
export async function startFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<StartedServer> {
  const projectRoot = entryProjectRootFromEnv(env);
  const detached = env['MNEMO_DETACHED'] === '1';
  const portRaw = env['MNEMO_PORT'];
  let port: number | undefined;
  if (portRaw !== undefined && portRaw !== '') {
    port = Number(portRaw);
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
      throw new MnemoError('PORT_UNAVAILABLE', `MNEMO_PORT の値が不正です: ${portRaw}`, { value: portRaw });
    }
  }
  return startServer({ projectRoot, detached, port });
}

/** `import.meta.url` で直接実行されたか(spawn 経由の起動)。 */
function isDirectEntry(): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(argv1).href;
  } catch {
    return false;
  }
}

if (isDirectEntry()) {
  startFromEnv()
    .then((started) => {
      const dispatch = (): void => {
        void started.stop().finally(() => process.exit(0));
      };
      // SIGHUP: 起動元ターミナルが閉じられたケース。これを拾わないと run.json が
      // 死んだ pid を指したまま残り、以後 detectRunningServer が誤って「停止中」と返す。
      process.on('SIGHUP', dispatch);
      process.on('SIGTERM', dispatch);
      process.on('SIGINT', dispatch);
      // どの経路でプロセスが落ちても run.json を道連れにする最後の砦(同期・best-effort)。
      // `stop()` が既に消していれば no-op。crash / SIGKILL 以外の想定外終了を掃除する。
      // run.json の pid が自分のときだけ消す(既存サーバーを adopt しただけの spawn が
      // 他人の run.json を削除しないため)。
      process.on('exit', () => {
        try {
          const cur = JSON.parse(fs.readFileSync(started.runJsonPath, 'utf8')) as { pid?: unknown };
          if (cur.pid === process.pid) {
            fs.unlinkSync(started.runJsonPath);
          }
        } catch {
          /* 既に無い / 読めない / 消せない → 無視 */
        }
      });
      // eslint-disable-next-line no-console
      console.error(`[mnemo:boot] listening on http://127.0.0.1:${started.port}`);
    })
    .catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error('[mnemo:boot] 起動に失敗しました:', err);
      process.exit(1);
    });
}
