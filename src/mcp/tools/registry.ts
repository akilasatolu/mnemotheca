// src/mcp/tools/registry.ts — 全 MCP tool モジュールの集約(設計 §8-L)。
//
// 各 tool ファイルが export する `ToolModule` をここで 1 か所に集め、`TOOL_MODULES`
// 配列にまとめる。`src/mcp/index.ts`(stdio エントリ)と `src/cli/commands/mcp.ts`
// (`mnemo mcp`)がこの配列を `startMcpStdio` に渡す。
//
// このモジュールは **import と結線のみ**でロジックを持たない。tool の実装・
// `server.ts`・`types.ts` は一切変更しない。
//
// export 形の実態(各ファイル参照):
//   - store.ts  → default export = 単一 `ToolModule`
//   - show.ts   → default export = 単一 `ToolModule`
//   - list.ts   → default export = `ToolModule[]`(list_categories / get_vault_info)
//   - organize.ts → named export ×4(default export なし)

import storeModule from './store.js';
import showModule from './show.js';
import listModules from './list.js';
import {
  organizeScanModule,
  organizePreviewModule,
  organizeApplyModule,
  organizeUndoModule,
} from './organize.js';
import type { ToolModule } from './types.js';

/**
 * MCP サーバーに登録する全 tool モジュール。
 * 順序は設計 §8-L の記述順(store → organize×4 → show → list×2)。
 */
export const TOOL_MODULES: ToolModule[] = [
  storeModule,
  organizeScanModule,
  organizePreviewModule,
  organizeApplyModule,
  organizeUndoModule,
  showModule,
  ...listModules,
];
