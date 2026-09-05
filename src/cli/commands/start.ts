// src/cli/commands/start.ts — `mnemo start [--port N] [--no-open]`(設計 §9-1 / §9-6)。
//
// projectRoot を解決済み(`cli/index.ts` の `NEEDS_PROJECT`)の状態で呼ばれる。
// `server/boot.ts` の `startServer({ projectRoot, detached: false })` を **同一プロセス**で
// 実行し、stdout に URL を出し、既定ブラウザを開く(`--no-open` で抑止)。
// Ctrl+C(SIGINT)/ SIGTERM で `started.stop()`(watcher close + server close + run.json 削除)
// を実行して graceful 終了する。
//
// テスト容易性のため `startServer` / ブラウザ起動 / シグナル待受はすべて `StartDeps` で
// 注入できる(既定は本物)。実 listen・実ブラウザ起動はテストでは行わない。

import openBrowser from 'open';

import { MnemoError } from '../../core/errors.js';
import { startServer as realStartServer } from '../../server/boot.js';
import type { StartedServer } from '../../server/boot.js';
import type { CliCommandContext } from '../index.js';
import * as ui from '../ui.js';

/** `mnemo start` の副作用注入ポイント。既定はすべて本物。 */
export interface StartDeps {
  /** `server/boot.ts` の `startServer`。 */
  startServer: (opts: {
    projectRoot: string;
    detached: boolean;
    port?: number;
  }) => Promise<StartedServer>;
  /** URL を既定ブラウザで開く。既定 `open`(npm)。 */
  open: (target: string) => Promise<unknown>;
  /**
   * SIGINT / SIGTERM を 1 回待って解決する。既定はプロセスシグナル待受。
   * テストは即解決する関数を渡す。
   */
  waitForShutdown: () => Promise<NodeJS.Signals | 'signal'>;
  /** 1 行出力(既定 stdout)。 */
  write: (line: string) => void;
}

function defaultWaitForShutdown(): Promise<NodeJS.Signals> {
  return new Promise((resolve) => {
    const onSignal = (sig: NodeJS.Signals): void => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      resolve(sig);
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  });
}

function resolveDeps(over?: Partial<StartDeps>): StartDeps {
  return {
    startServer: realStartServer,
    open: (target: string) => openBrowser(target),
    waitForShutdown: defaultWaitForShutdown,
    write: (line: string) => process.stdout.write(`${line}\n`),
    ...over,
  };
}

/** `--port <n>` を検証して数値化する。不正なら `PORT_UNAVAILABLE`。 */
function parsePort(raw: unknown): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 65_535) {
    throw new MnemoError('PORT_UNAVAILABLE', `--port の値が不正です: ${String(raw)}`, {
      value: raw,
    });
  }
  return n;
}

export async function run(
  ctx: CliCommandContext,
  over?: Partial<StartDeps>,
): Promise<void> {
  const deps = resolveDeps(over);
  const projectRoot = ctx.projectRoot;
  if (projectRoot === undefined) {
    // NEEDS_PROJECT 対象なので通常ここには来ない(防御的)。
    throw new MnemoError('NOT_INITIALIZED', 'projectRoot を解決できませんでした');
  }

  const port = parsePort(ctx.options['port']);
  const noOpen = ctx.options['open'] === false;
  const { json, quiet } = ctx.global;

  const started = await deps.startServer({
    projectRoot,
    detached: false,
    ...(port !== undefined ? { port } : {}),
  });

  const tokenUrl = `http://127.0.0.1:${started.port}/?t=${started.token}`;
  const bareUrl = `http://127.0.0.1:${started.port}`;

  if (json) {
    deps.write(JSON.stringify({ url: tokenUrl, port: started.port, projectRoot }));
  } else if (!quiet) {
    deps.write(ui.success(`Mnemo サーバーを起動しました: ${bareUrl}`));
    deps.write(ui.dim('停止するには Ctrl+C を押してください。'));
  }

  if (!noOpen) {
    try {
      await deps.open(tokenUrl);
    } catch {
      if (!quiet && !json) {
        deps.write(ui.warn(`ブラウザを開けませんでした。次の URL を開いてください: ${tokenUrl}`));
      }
    }
  }

  await deps.waitForShutdown();
  await started.stop();

  if (!quiet && !json) {
    deps.write(ui.dim('停止しました。'));
  }
}
