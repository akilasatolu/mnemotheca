import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProgram, run, SUBCOMMANDS, type CliCommandContext } from '../../src/cli/index.js';
import * as ui from '../../src/cli/ui.js';
import { makeProject } from '../helpers/project.js';

const PKG_VERSION = (
  JSON.parse(
    fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { version: string }
).version;

const tmpDirs: string[] = [];

/** `.mnemotheca/` を持たない使い捨てディレクトリ(実体パス)。 */
function emptyDir(): string {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mnemo-cli-')));
  tmpDirs.push(d);
  return d;
}

function real(p: string): string {
  return fs.realpathSync.native(p);
}

interface Captured {
  out: string;
  err: string;
}

/** stdout / stderr をキャプチャして cb を実行する。 */
async function capture(cb: () => Promise<number>): Promise<Captured & { code: number }> {
  const out: string[] = [];
  const err: string[] = [];
  const o = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
  const e = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: unknown) => {
      err.push(String(chunk));
      return true;
    });
  try {
    const code = await cb();
    return { code, out: out.join(''), err: err.join('') };
  } finally {
    o.mockRestore();
    e.mockRestore();
  }
}

/** ctx を捕まえる dispatch。 */
function captureDispatch(): { calls: CliCommandContext[]; dispatch: (n: string, c: CliCommandContext) => void } {
  const calls: CliCommandContext[] = [];
  return { calls, dispatch: (_n, c) => void calls.push(c) };
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe('createProgram', () => {
  it('registers exactly the §9-1 subcommands and no `config`', () => {
    const names = createProgram()
      .commands.map((c) => c.name())
      .sort();
    expect(names).toEqual([...SUBCOMMANDS].sort());
    expect(names).not.toContain('config');
  });

  it('exposes the global options --project / --json / --quiet', () => {
    const flags = createProgram().options.map((o) => o.long);
    expect(flags).toEqual(expect.arrayContaining(['--json', '--project', '--quiet']));
    expect(createProgram().options.find((o) => o.long === '--project')?.required).toBe(true);
  });
});

describe('mnemo --version / --help (commander 標準)', () => {
  it('--version prints the package.json version and exits 0', async () => {
    const r = await capture(() => run(['--version']));
    expect(r.code).toBe(0);
    expect(r.out).toContain(PKG_VERSION);
  });

  it('--help lists every subcommand and exits 0', async () => {
    const r = await capture(() => run(['--help']));
    expect(r.code).toBe(0);
    for (const name of SUBCOMMANDS) {
      expect(r.out).toMatch(new RegExp(`\\b${name}\\b`));
    }
    // `config` は廃止 — Commands セクションに現れない
    expect(r.out).not.toMatch(/^\s+config\b/m);
  });

  it('unknown command exits 1', async () => {
    const r = await capture(() => run(['frobnicate']));
    expect(r.code).toBe(1);
  });
});

describe('projectRoot 解決(設計 §13-14)', () => {
  it('.mnemotheca/config.json の無いディレクトリで `mnemo start` → NOT_INITIALIZED(赤字 + 案内 + exit 1)', async () => {
    const dir = emptyDir();
    const r = await capture(() => run(['start'], { cwd: dir }));

    expect(r.code).toBe(1);
    expect(r.err).toContain('初期化されていません');
    expect(r.err).toContain('次のコマンドで解決できます: mnemo init');
    expect(r.out).toBe('');
    if (ui.colorEnabled) {
      expect(r.err).toContain('\x1b[31m'); // 赤
    }
  });

  it('--json 時は NOT_INITIALIZED を機械可読な JSON で stdout に出す', async () => {
    const dir = emptyDir();
    const r = await capture(() => run(['--json', 'start'], { cwd: dir }));

    expect(r.code).toBe(1);
    expect(r.err).toBe('');
    const parsed = JSON.parse(r.out) as { error: { code: string; message: string } };
    expect(parsed.error.code).toBe('NOT_INITIALIZED');
    expect(typeof parsed.error.message).toBe('string');
  });

  it('サブディレクトリから実行 → 親を探索して projectRoot を発見する', async () => {
    const proj = await makeProject();
    tmpDirs.push(proj);
    const sub = path.join(proj, 'vault', 'knowledge');
    const cap = captureDispatch();

    const r = await capture(() => run(['status'], { cwd: sub, dispatch: cap.dispatch }));

    expect(r.code).toBe(0);
    expect(cap.calls).toHaveLength(1);
    expect(cap.calls[0]?.projectRoot).toBe(real(proj));
  });

  it('--project が cwd 探索より優先される', async () => {
    const proj = await makeProject();
    tmpDirs.push(proj);
    const cwd = emptyDir(); // ここには projectRoot が無い
    const cap = captureDispatch();

    const r = await capture(() =>
      run(['--project', proj, 'status'], { cwd, dispatch: cap.dispatch }),
    );

    expect(r.code).toBe(0);
    expect(cap.calls[0]?.projectRoot).toBe(real(proj));
  });

  it('MNEMO_PROJECT env が cwd 探索より優先される', async () => {
    const proj = await makeProject();
    tmpDirs.push(proj);
    const cwd = emptyDir();
    vi.stubEnv('MNEMO_PROJECT', proj);
    const cap = captureDispatch();

    const r = await capture(() => run(['status'], { cwd, dispatch: cap.dispatch }));

    expect(r.code).toBe(0);
    expect(cap.calls[0]?.projectRoot).toBe(real(proj));
  });

  it('projectRoot を必要としない `init` では解決を試みない(未初期化 cwd でも成功)', async () => {
    const cwd = emptyDir();
    const cap = captureDispatch();

    const r = await capture(() => run(['init'], { cwd, dispatch: cap.dispatch }));

    expect(r.code).toBe(0);
    expect(cap.calls[0]?.projectRoot).toBeUndefined();
  });
});

describe('サブコマンド実体への橋渡し', () => {
  it('位置引数・オプション・グローバルオプションを ctx に載せる', async () => {
    const cwd = emptyDir();
    const cap = captureDispatch();

    await capture(() =>
      run(['--quiet', 'init', 'my-brain'], { cwd, dispatch: cap.dispatch }),
    );

    const ctx = cap.calls[0];
    expect(ctx?.name).toBe('init');
    expect(ctx?.args).toEqual(['my-brain']);
    expect(ctx?.global.quiet).toBe(true);
    expect(ctx?.global.json).toBe(false);
  });

  it('reindex の --full / --no-categories を ctx.options に載せる', async () => {
    const proj = await makeProject();
    tmpDirs.push(proj);
    const cap = captureDispatch();

    await capture(() =>
      run(['reindex', '--full', '--no-categories'], { cwd: proj, dispatch: cap.dispatch }),
    );

    expect(cap.calls[0]?.options).toMatchObject({ full: true, categories: false });
  });

  // lazyDispatch の「実体の無いサブコマンド → 弱調メッセージ + 正常終了」フォールバックは
  // 開発期の足場。8 サブコマンド (init/start/stop/status/reindex/mcp/doctor/open) が
  // すべて実装された現在、登録済みコマンドからは到達しない経路のため専用テストは撤去した
  // (未知コマンドは commander が exit 1 = 上の 'unknown command exits 1' で担保)。
});
