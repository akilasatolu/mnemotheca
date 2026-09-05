// src/cli/commands/open.ts — `mnemo open`(設計 §9-1)。
//
// 稼働中サーバー(`detectRunningServer` = run.json + pid + healthz projectRoot 一致)を
// 検出できたら、そのトークン付き URL を既定ブラウザで開く。ブラウザ起動に失敗しても
// URL は表示する(致命的でない)。未稼働なら `mnemo start` を促して終了する。
//
// ブラウザ起動 / サーバー検出は `OpenDeps` で注入できる(既定は本物)。

import openBrowser from 'open';

import { MnemoError } from '../../core/errors.js';
import { detectRunningServer as realDetectRunningServer } from '../../mcp/reindex-client.js';
import type { ServerDetection } from '../../mcp/reindex-client.js';
import type { CliCommandContext } from '../index.js';
import * as ui from '../ui.js';

/** `mnemo open` の依存注入ポイント。 */
export interface OpenDeps {
  detectRunningServer: (projectRoot: string) => Promise<ServerDetection>;
  /** URL を既定ブラウザで開く。既定 `open`(npm)。 */
  open: (target: string) => Promise<unknown>;
  /** 1 行出力(既定 stdout)。 */
  write: (line: string) => void;
  /** 案内・警告の出力(既定 stderr)。 */
  writeErr: (line: string) => void;
}

function resolveDeps(over?: Partial<OpenDeps>): OpenDeps {
  return {
    detectRunningServer: (projectRoot: string) => realDetectRunningServer(projectRoot),
    open: (target: string) => openBrowser(target),
    write: (line: string) => process.stdout.write(`${line}\n`),
    writeErr: (line: string) => process.stderr.write(`${line}\n`),
    ...over,
  };
}

export async function run(
  ctx: CliCommandContext,
  over?: Partial<OpenDeps>,
): Promise<void> {
  const deps = resolveDeps(over);
  const projectRoot = ctx.projectRoot;
  if (projectRoot === undefined) {
    throw new MnemoError('NOT_INITIALIZED', 'projectRoot を解決できませんでした');
  }
  const { json, quiet } = ctx.global;

  const detection = await deps.detectRunningServer(projectRoot);
  if (!detection.running || detection.run === null) {
    if (json) {
      deps.write(JSON.stringify({ running: false }));
    } else {
      deps.writeErr(
        ui.warn('サーバーが起動していません。`mnemo start` で起動してください。'),
      );
    }
    return;
  }

  const url = `http://127.0.0.1:${detection.run.port}/?t=${detection.run.token}`;
  const bareUrl = `http://127.0.0.1:${detection.run.port}`;

  let browserOpened = false;
  try {
    await deps.open(url);
    browserOpened = true;
  } catch {
    browserOpened = false;
  }

  if (json) {
    deps.write(JSON.stringify({ running: true, url, browserOpened }));
    return;
  }
  if (quiet) {
    return;
  }
  if (browserOpened) {
    deps.write(ui.success(`ブラウザで開きました: ${bareUrl}`));
  } else {
    deps.write(ui.warn('ブラウザを自動で開けませんでした。次の URL を開いてください:'));
    deps.write(url);
  }
}
