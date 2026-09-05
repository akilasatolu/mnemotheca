#!/usr/bin/env node
// mnemo MCP stdio サーバーエントリ。Claude Desktop / Claude Code がスニペットの
// command=node 絶対パス / args=<projectRoot>/dist/mcp/index.js で spawn する。
//
// 設計 §8-L — このファイルは `startMcpStdio(TOOL_MODULES)` を呼ぶだけのエントリ。
// projectRoot 解決(MNEMO_PROJECT / --project / アンカー探索)・Node バージョンガード・
// repairUsageTail・stdio 接続はすべて `startMcpStdio`(src/mcp/server.ts)が内包する。
// tool の集約は `src/mcp/tools/registry.ts` の `TOOL_MODULES`。

import { startMcpStdio } from './server.js';
import { TOOL_MODULES } from './tools/registry.js';

void startMcpStdio(TOOL_MODULES);
