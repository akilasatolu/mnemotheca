import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { McpServer } from '@modelcontextprotocol/server';

import { MnemoError } from '../../src/core/errors.js';
import { makeProject } from '../helpers/project.js';

// stdio サブパスをモック(実際の stdin/stdout 接続を避ける)。
const serveStdioMock = vi.fn();
vi.mock('@modelcontextprotocol/server/stdio', () => ({
  serveStdio: (...args: unknown[]) => serveStdioMock(...args),
  StdioServerTransport: class {},
}));

const { createMcpServer, startMcpStdio, withToolErrorBoundary } = await import('../../src/mcp/server.js');
type ToolModule = import('../../src/mcp/tools/types.js').ToolModule;

/** テスト用の最小 ToolModule。 */
function fakeModule(name: string, handler?: ToolModule['handler']): ToolModule {
  return {
    name,
    config: {
      title: name,
      description: `desc of ${name}`,
      inputSchema: z.object({ q: z.string() }),
    },
    handler:
      handler ??
      (async () => ({ content: [{ type: 'text' as const, text: 'ok' }] })),
  };
}

const origVersions = process.versions;

afterEach(() => {
  vi.restoreAllMocks();
  serveStdioMock.mockReset();
  Object.defineProperty(process, 'versions', { value: origVersions, configurable: true });
  delete process.env.MNEMO_PROJECT;
});

describe('withToolErrorBoundary (§8-L / §13-12)', () => {
  it('MnemoError を投げる handler → isError:true + structuredContent.code/details', async () => {
    const wrapped = withToolErrorBoundary(async () => {
      throw new MnemoError('SLUG_COLLISION', 'boom', { slug: 'x' });
    });

    const res = await wrapped({}, {} as never);

    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({ code: 'SLUG_COLLISION', details: { slug: 'x' } });
    expect(res.content[0]).toMatchObject({ type: 'text' });
    expect(typeof (res.content[0] as { text: string }).text).toBe('string');
  });

  it('MnemoError 以外の例外も握って generic な isError:true にする', async () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const wrapped = withToolErrorBoundary(async () => {
      throw new Error('unexpected kaboom');
    });

    const res = await wrapped({}, {} as never);

    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({ code: 'UNEXPECTED' });
    expect(errSpy).toHaveBeenCalled();
  });

  it('正常な handler の戻り値はそのまま透過する', async () => {
    const wrapped = withToolErrorBoundary(async () => ({
      content: [{ type: 'text' as const, text: 'hi' }],
      structuredContent: { n: 1 },
    }));

    const res = await wrapped({}, {} as never);
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toEqual({ n: 1 });
  });
});

describe('createMcpServer (§8-L)', () => {
  it('モック ToolModule[] の全要素を registerTool する', async () => {
    const spy = vi
      .spyOn(McpServer.prototype, 'registerTool')
      .mockImplementation(() => ({}) as never);

    const modules = [fakeModule('mnemo_a'), fakeModule('mnemo_b'), fakeModule('mnemo_c')];
    const server = await createMcpServer('/nonexistent/root', modules);

    expect(server).toBeInstanceOf(McpServer);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy.mock.calls.map((c) => c[0])).toEqual(['mnemo_a', 'mnemo_b', 'mnemo_c']);
    // 第 2 引数は config そのまま、第 3 引数はラップされた関数
    expect(spy.mock.calls[0]![1]).toBe(modules[0]!.config);
    expect(typeof spy.mock.calls[0]![2]).toBe('function');
    expect(spy.mock.calls[0]![2]).not.toBe(modules[0]!.handler);
  });

  it('登録された handler に渡る ctx.projectRoot が createMcpServer の第1引数と一致する', async () => {
    let seen: { projectRoot?: unknown; mcpReq?: unknown } | undefined;
    let registered: ((args: unknown, extra: unknown) => Promise<unknown>) | undefined;
    vi.spyOn(McpServer.prototype, 'registerTool').mockImplementation(((
      _name: string,
      _config: unknown,
      cb: (args: unknown, extra: unknown) => Promise<unknown>,
    ) => {
      registered = cb;
      return {} as never;
    }) as never);

    const mod = fakeModule('mnemo_ctx', async (_args, ctx) => {
      seen = { projectRoot: ctx.projectRoot, mcpReq: ctx.mcpReq };
      return { content: [{ type: 'text' as const, text: 'ok' }] };
    });
    await createMcpServer('/some/project/root', [mod]);

    // SDK が (args, extra) で呼ぶのを模倣。extra.mcpReq が ctx.mcpReq に届く。
    await registered!({ q: 'x' }, { mcpReq: { elicitInput: () => undefined } });

    expect(seen).toBeDefined();
    expect(seen!.projectRoot).toBe('/some/project/root');
    expect(seen!.mcpReq).toMatchObject({ elicitInput: expect.any(Function) });
  });

  it('登録された handler は withToolErrorBoundary でラップされている(MnemoError → isError)', async () => {
    let registered: ((args: unknown, ctx: unknown) => Promise<unknown>) | undefined;
    vi.spyOn(McpServer.prototype, 'registerTool').mockImplementation(((
      _name: string,
      _config: unknown,
      cb: (args: unknown, ctx: unknown) => Promise<unknown>,
    ) => {
      registered = cb;
      return {} as never;
    }) as never);

    const mod = fakeModule('mnemo_boom', async () => {
      throw new MnemoError('PII_BLOCKED', 'nope');
    });
    await createMcpServer('/root', [mod]);

    const res = (await registered!({}, {})) as { isError?: boolean; structuredContent?: unknown };
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({ code: 'PII_BLOCKED' });
  });
});

describe('startMcpStdio (§13-12)', () => {
  it('Node バージョンガード: node 18 系 → stderr + exit(1)・serveStdio 未呼び出し', async () => {
    Object.defineProperty(process, 'versions', {
      value: { ...origVersions, node: '18.19.1' },
      configurable: true,
    });
    const errSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await startMcpStdio([fakeModule('mnemo_a')]);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy).toHaveBeenCalled();
    expect(String(errSpy.mock.calls[0]![0])).toContain('Node 20');
    expect(serveStdioMock).not.toHaveBeenCalled();
  });

  it('MNEMO_PROJECT が config 無しディレクトリ → NOT_INITIALIZED で非 0 終了・serveStdio 未呼び出し', async () => {
    const empty = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mnemo-noconf-'));
    try {
      process.env.MNEMO_PROJECT = empty;
      const errSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

      await startMcpStdio([fakeModule('mnemo_a')]);

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(String(errSpy.mock.calls[0]![0])).toContain('NOT_INITIALIZED');
      expect(serveStdioMock).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('正常系: serveStdio に factory を渡し、factory は McpServer を生成する', async () => {
    const root = await makeProject();
    try {
      process.env.MNEMO_PROJECT = root;
      vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      const regSpy = vi
        .spyOn(McpServer.prototype, 'registerTool')
        .mockImplementation(() => ({}) as never);

      await startMcpStdio([fakeModule('mnemo_a'), fakeModule('mnemo_b')]);

      expect(serveStdioMock).toHaveBeenCalledTimes(1);
      const factory = serveStdioMock.mock.calls[0]![0] as () => Promise<McpServer>;
      expect(typeof factory).toBe('function');
      const server = await factory();
      expect(server).toBeInstanceOf(McpServer);
      expect(regSpy).toHaveBeenCalledTimes(2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
