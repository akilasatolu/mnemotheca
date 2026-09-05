// src/mcp/tools/types.ts — MCP tool モジュールの共通インターフェース(設計 §8-L)。
//
// 各 tool(store / organize_* / list_* / show …)は「1 ファイル = 1 `ToolModule`」として
// `{ name, config, handler }` を default / named export し、結線層(registry.ts /
// src/mcp/index.ts)がそれらを集めて `createMcpServer` / `startMcpStdio` に配列で渡す。
// server.ts はこの型のみに依存し、個々の tool 実装も registry も import しない。

import type {
  CallToolResult,
  Icon,
  ServerContext,
  StandardSchemaWithJSON,
  ToolAnnotations,
} from '@modelcontextprotocol/server';

import type { ElicitCapableContext } from '../elicit.js';

/**
 * `McpServer.registerTool(name, config, handler)` の第 2 引数(config)と同形。
 * `inputSchema` / `outputSchema` は Standard Schema(Zod v4 の `z.object()` をそのまま渡してよい。
 * `zodToJsonSchema` は不要 / SDK が `tools/list` 用 JSON Schema を生成する)。
 */
export interface ToolModuleConfig {
  title?: string;
  description?: string;
  inputSchema?: StandardSchemaWithJSON;
  outputSchema?: StandardSchemaWithJSON;
  annotations?: ToolAnnotations;
  icons?: Icon[];
  _meta?: Record<string, unknown>;
}

/**
 * tool handler が受け取る context(設計 §8-L / PM 決定)。
 *
 * MCP SDK が handler 第 2 引数で渡してくる `ServerContext`(extra)そのものではなく、
 * `createMcpServer` が projectRoot を注入した自前の context。各 tool は
 * `ctx.projectRoot` で vault / config のパスを解決し、`ctx.mcpReq` で elicitation を試みる
 * (`mcp/elicit.ts` の `tryElicit(ctx, ...)` にそのまま渡せる)。
 */
export interface ToolContext {
  /** `createMcpServer` の第 1 引数がそのまま入る。tool のパス解決の起点。 */
  projectRoot: string;
  /** MCP SDK の handler 第 2 引数(`ServerContext` / extra)。elicitation・sampling 等に使う。 */
  mcpReq?: ElicitCapableContext['mcpReq'];
  /** リクエストのキャンセルシグナル(SDK が提供する場合)。 */
  signal?: AbortSignal;
}

/**
 * tool handler。第 1 引数はパース済み入力(`inputSchema` があるとき)、第 2 引数は
 * `ToolContext`(projectRoot 注入済み)。戻り値は `CallToolResult`
 * (`{ content: [{ type: 'text', text }], structuredContent?, isError? }`)。
 *
 * メソッド構文 + `args: any` は意図的:各 tool が自分の Zod 出力型で handler を書けるよう、
 * `ToolModule[]` へ代入するときに引数型の非互換(strictFunctionTypes の反変)を避ける。
 * 実際の入力検証は SDK が `inputSchema` で行うため handler 到達時点で型は確定している。
 */
export interface ToolModule {
  /** MCP tool 名(例: `mnemo_store`)。`registerTool` の第 1 引数。 */
  name: string;
  /** `registerTool` の第 2 引数。`name` は含めない。 */
  config: ToolModuleConfig;
  /** tool 本体。`createMcpServer` が projectRoot 注入 + `withToolErrorBoundary` でラップして登録する。 */
  handler(args: any, ctx: ToolContext): Promise<CallToolResult>;
}

/** `ToolModule['handler']` 単体の別名(`withToolErrorBoundary` の入出力型)。 */
export type ToolHandler = ToolModule['handler'];

export type { CallToolResult, ServerContext };
