// src/cli/commands/mcp.ts — `mnemo mcp`(設計 §8-L / §9-1)。
//
// stdio MCP サーバーを起動する(MCP クライアント設定用。人間は直接使わない)。
// `dist/mcp/index.js` と同じく `startMcpStdio(TOOL_MODULES)` を呼ぶだけの薄い結線。
// Node バージョンガード・projectRoot 解決(MNEMO_PROJECT / --project / アンカー探索)・
// repairUsageTail・stdio 接続はすべて `startMcpStdio`(src/mcp/server.ts)が内包する。

import { startMcpStdio } from '../../mcp/server.js';
import { TOOL_MODULES } from '../../mcp/tools/registry.js';
import type { CliCommandContext } from '../index.js';

export async function run(_ctx: CliCommandContext): Promise<void> {
  await startMcpStdio(TOOL_MODULES);
}
