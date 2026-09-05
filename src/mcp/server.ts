// src/mcp/server.ts — MCP stdio サーバーの生成と起動(設計 §8-L / §13-12)。
//
// この 2 関数は渡された `ToolModule[]` だけで完結する。個々の tool 実装・registry.ts・
// src/mcp/index.ts・CLI は一切 import しない(結線は `src/mcp/tools/registry.ts` の責務)。

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { isMnemoError } from '../core/errors.js';
import { resolveProjectRoot } from '../core/paths.js';
import { repairUsageTail } from '../core/usage-log.js';
import { formatMnemoError } from './format.js';
import type { ElicitCapableContext } from './elicit.js';
import type { CallToolResult, ToolContext, ToolHandler, ToolModule } from './tools/types.js';

/** 自身の package.json から version を読む(dist/mcp/ と src/mcp/ のどちらからでも `../../`)。 */
const PKG_VERSION: string = (() => {
  try {
    const pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
    const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

const NODE_VERSION_MESSAGE =
  '[NODE_VERSION_UNSUPPORTED] Node 20 以上が必要です。MCP スニペットの command を ' +
  'node 20 の絶対パスに変更してください(projectRoot 内で `mnemo doctor` が正しい ' +
  'スニペットを再生成します)。';

/**
 * tool handler を例外境界でラップする高階関数(設計 §8-L)。
 *
 * - `MnemoError` → `{ content:[{type:'text',text: formatMnemoError(err)}], isError:true,
 *   structuredContent:{ code, details } }`(§12-1)
 * - それ以外の例外 → 握りつぶして generic な `isError:true` 結果にする(スタックは stderr へ)
 */
export function withToolErrorBoundary(handler: ToolHandler): ToolHandler {
  return async function wrapped(args: unknown, ctx: ToolContext): Promise<CallToolResult> {
    try {
      return await handler(args, ctx);
    } catch (err) {
      if (isMnemoError(err)) {
        return {
          content: [{ type: 'text' as const, text: formatMnemoError(err) }],
          isError: true,
          structuredContent: { code: err.code, details: err.details ?? {} },
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[mnemo mcp] unexpected tool error: ${message}\n`);
      return {
        content: [
          {
            type: 'text' as const,
            text: '予期しないエラーが発生しました。時間をおいて再試行してください。',
          },
        ],
        isError: true,
        structuredContent: { code: 'UNEXPECTED', message },
      };
    }
  };
}

/**
 * MCP SDK の handler 呼び出し `(args, extra)` を、projectRoot 注入済みの自前
 * `(args, ctx: ToolContext)` へ変換したうえで `withToolErrorBoundary` と合成する。
 * SDK が渡す extra(`ServerContext`)は `ctx.mcpReq`(elicitation 用)へマージする。
 */
function bindToolContext(
  projectRoot: string,
  handler: ToolHandler,
): (args: unknown, extra: unknown) => Promise<CallToolResult> {
  const guarded = withToolErrorBoundary(handler);
  return (args, extra) => {
    const ex = extra as (ElicitCapableContext & { signal?: AbortSignal }) | undefined;
    const ctx: ToolContext = {
      projectRoot,
      mcpReq: ex?.mcpReq,
      signal: ex?.signal,
    };
    return guarded(args, ctx);
  };
}

/**
 * `ToolModule[]` から `McpServer` を 1 インスタンス生成する(設計 §8-L)。
 * 全 handler は projectRoot 注入 + `withToolErrorBoundary` でラップして登録する。
 * `serveStdio` の factory から呼べるよう毎回新しいインスタンスを返す。
 */
export async function createMcpServer(
  projectRoot: string,
  toolModules: ToolModule[],
): Promise<McpServer> {
  const server = new McpServer(
    { name: 'mnemotheca', version: PKG_VERSION },
    { capabilities: { tools: {} } },
  );

  for (const mod of toolModules) {
    server.registerTool(mod.name, mod.config, bindToolContext(projectRoot, mod.handler));
  }

  return server;
}

/**
 * stdio で MCP サーバーを起動する(設計 §8-L step 0〜4)。
 *
 * 接続は低レベル `connect(new StdioServerTransport())` ではなく `serveStdio(() =>
 * createMcpServer(...))` の factory 形式を使う(プロトコルの era 決定を SDK に委ね、
 * 2025 系クライアントも `legacy:'serve'` 既定で受ける — 低レベル connect は 2025 系に固定
 * されてしまい、将来のプロトコル更新に追従できない)。設計 §8-L の step 順は維持:
 *   step 0 Node ガード(factory の外・transport 未接続で exit)
 *   step 1 resolveProjectRoot / step 2 repairUsageTail(非同期初期化を factory 前に完了)
 *   step 3 createMcpServer / step 4 stdio 接続 = serveStdio(factory)
 */
export async function startMcpStdio(toolModules: ToolModule[]): Promise<void> {
  // step 0: Node バージョンガード。stdio JSON-RPC は開始しない。
  if (Number.parseInt(process.versions.node, 10) < 20) {
    process.stderr.write(`${NODE_VERSION_MESSAGE}\n`);
    process.exit(1);
    return; // process.exit が(テストで)スタブされている場合の保険
  }

  // step 1: projectRoot 解決(MNEMO_PROJECT / --project override → アンカー探索)。
  let projectRoot: string;
  try {
    projectRoot = resolveProjectRoot({
      startDir: path.dirname(fileURLToPath(import.meta.url)),
    });
  } catch (err) {
    const code = isMnemoError(err) ? err.code : 'UNEXPECTED';
    const text = isMnemoError(err)
      ? formatMnemoError(err)
      : err instanceof Error
        ? err.message
        : String(err);
    process.stderr.write(`[${code}] ${text}\n`);
    process.exit(1);
    return;
  }

  // step 2: usage_log の壊れた末尾行を修復。
  await repairUsageTail(projectRoot);

  // step 3 + 4: factory を serveStdio に渡す(接続ごとに 1 インスタンスを pin)。
  serveStdio(() => createMcpServer(projectRoot, toolModules));
}
