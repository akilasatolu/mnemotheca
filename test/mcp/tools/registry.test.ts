import { afterEach, describe, expect, it, vi } from 'vitest';

import { TOOL_MODULES } from '../../../src/mcp/tools/registry.js';
type ToolModule = import('../../../src/mcp/tools/types.js').ToolModule;

// startMcpStdio をモック(実際の stdio 接続・projectRoot 解決を避ける)。
const startMcpStdioMock = vi.fn(async (_mods: ToolModule[]) => undefined);
vi.mock('../../../src/mcp/server.js', () => ({
  startMcpStdio: (...args: unknown[]) => startMcpStdioMock(...(args as [ToolModule[]])),
}));

const EXPECTED_NAMES = [
  'mnemo_store',
  'mnemo_organize_scan',
  'mnemo_organize_preview',
  'mnemo_organize_apply',
  'mnemo_organize_undo',
  'mnemo_show',
  'mnemo_list_categories',
  'mnemo_get_vault_info',
] as const;

describe('TOOL_MODULES (§8-L)', () => {
  it('8 エントリが過不足なく載る(順序は §8-L 記述順)', () => {
    expect(TOOL_MODULES).toHaveLength(8);
    expect(TOOL_MODULES.map((m) => m.name)).toEqual(EXPECTED_NAMES);
  });

  it('name の重複が無い', () => {
    const names = TOOL_MODULES.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('各要素が ToolModule 形(name 文字列・config オブジェクト・handler 関数)', () => {
    for (const mod of TOOL_MODULES) {
      expect(typeof mod.name).toBe('string');
      expect(mod.name.length).toBeGreaterThan(0);
      expect(mod.config).toBeTypeOf('object');
      expect(mod.config).not.toBeNull();
      expect(mod.handler).toBeTypeOf('function');
    }
  });

  it('個々の期待 tool がちょうど 1 つずつ含まれる', () => {
    for (const name of EXPECTED_NAMES) {
      expect(TOOL_MODULES.filter((m) => m.name === name)).toHaveLength(1);
    }
  });
});

describe('エントリ結線 (§8-L)', () => {
  afterEach(() => {
    startMcpStdioMock.mockClear();
  });

  it('src/mcp/index.ts が startMcpStdio に TOOL_MODULES を渡す', async () => {
    await import('../../../src/mcp/index.js');
    expect(startMcpStdioMock).toHaveBeenCalledTimes(1);
    expect(startMcpStdioMock.mock.calls[0]?.[0]).toBe(TOOL_MODULES);
  });

  it('src/cli/commands/mcp.ts の run() が startMcpStdio に TOOL_MODULES を渡す', async () => {
    const mod = await import('../../../src/cli/commands/mcp.js');
    await mod.run({} as never);
    expect(startMcpStdioMock).toHaveBeenCalledTimes(1);
    expect(startMcpStdioMock.mock.calls[0]?.[0]).toBe(TOOL_MODULES);
  });
});
