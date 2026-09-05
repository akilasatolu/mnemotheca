import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { run as runInit, MNEMO_GITHUB_SLUG, type InitDeps } from '../../src/cli/commands/init.js';
import type { CliCommandContext } from '../../src/cli/index.js';
import { isMnemoError } from '../../src/core/errors.js';
import { buildMcpSnippet } from '../../src/core/mcp-snippet.js';

const tmpDirs: string[] = [];

function emptyDir(): string {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mnemo-init-')));
  tmpDirs.push(d);
  return d;
}

/** `node_modules/mnemo/dist/{cli,mcp}/index.js`(npm install 済みの体裁)を仕込む。 */
function seedInstalled(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules', 'mnemo', 'dist', 'cli'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules', 'mnemo', 'dist', 'mcp'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'mnemo', 'dist', 'cli', 'index.js'), '// cli\n');
  fs.writeFileSync(path.join(dir, 'node_modules', 'mnemo', 'dist', 'mcp', 'index.js'), '// mcp\n');
}

/** projectRoot として使う、npm install 済みのディレクトリ。 */
function installedTarget(): { base: string; dir: string; name: string } {
  const base = emptyDir();
  const name = 'my-brain';
  const dir = path.join(base, name);
  seedInstalled(dir);
  return { base, dir, name };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function makeCtx(args: string[] = [], global: Partial<CliCommandContext['global']> = {}): CliCommandContext {
  return {
    name: 'init',
    args,
    options: {},
    global: { project: undefined, json: false, quiet: false, ...global },
    projectRoot: undefined,
  };
}

interface Harness {
  out: () => string;
  deps: InitDeps;
  buildIndex: ReturnType<typeof vi.fn>;
  regenerateCategories: ReturnType<typeof vi.fn>;
  confirmUseExistingDir: ReturnType<typeof vi.fn>;
  confirmUseExistingVault: ReturnType<typeof vi.fn>;
}

function harness(overrides: Partial<InitDeps> = {}): Harness {
  const chunks: string[] = [];
  const buildIndex = vi.fn(async () => undefined);
  const regenerateCategories = vi.fn(async () => undefined);
  const confirmUseExistingDir = vi.fn(async () => true);
  const confirmUseExistingVault = vi.fn(async () => true);
  const deps: InitDeps = {
    nodeVersion: 'v20.11.0',
    buildIndex,
    regenerateCategories,
    buildMcpSnippet,
    prompts: { confirmUseExistingDir, confirmUseExistingVault },
    now: () => new Date('2026-09-03T00:00:00.000Z'),
    out: (c: string) => void chunks.push(c),
    ...overrides,
  };
  return {
    out: () => chunks.join(''),
    deps,
    buildIndex,
    regenerateCategories,
    confirmUseExistingDir,
    confirmUseExistingVault,
  };
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------

describe('mnemo init — 生成物一式', () => {
  it('npm install 済みディレクトリに .gitignore / config.json / vault を作り buildIndex + スニペット出力する', async () => {
    const { base, dir, name } = installedTarget();
    const h = harness({ cwd: base });

    await runInit(makeCtx([name]), h.deps);

    // node_modules/mnemo は init が触らない
    expect(fs.existsSync(path.join(dir, 'node_modules', 'mnemo', 'dist', 'cli', 'index.js'))).toBe(true);

    // .gitignore — 管理ブロックのみ。vault/ と .mnemotheca/config.json を追跡し、
    // node_modules/・派生インデックス・スナップショットは除外する。
    const gitignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    expect(gitignore).toBe(
      [
        '# >>> mnemo (managed by `mnemo init` — edit outside this block) >>>',
        '/*',
        '!/vault/',
        '!/.gitignore',
        '!/.mnemotheca/',
        '/.mnemotheca/index/',
        '/.mnemotheca/snapshots/',
        '# <<< mnemo <<<',
        '',
      ].join('\n'),
    );
    // config.json 用の除外行は無い(= 追跡される)
    expect(gitignore).not.toContain('config.json');

    // config.json
    const cfg = readJson(path.join(dir, '.mnemotheca', 'config.json'));
    expect(cfg).toEqual({
      v: 1,
      createdAt: '2026-09-03T00:00:00.000Z',
      updatedAt: '2026-09-03T00:00:00.000Z',
    });

    // vault
    expect(fs.existsSync(path.join(dir, 'vault', 'knowledge'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'vault', 'categories'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'vault', '.mnemotheca-vault.json'))).toBe(true);

    // buildIndex 実行
    expect(h.buildIndex).toHaveBeenCalledTimes(1);
    expect(h.buildIndex).toHaveBeenCalledWith(dir);

    // スニペット出力が buildMcpSnippet と一致
    const snip = buildMcpSnippet(dir, { client: 'desktop' });
    expect(h.out()).toContain(snip.snippet);
    expect(h.out()).toContain(snip.serverKey);
    expect(h.out()).toContain(snip.filename);

    // 自動編集しない: Claude 設定ファイルを作らない
    expect(fs.existsSync(path.join(dir, 'claude_desktop_config.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.mcp.json'))).toBe(false);
  });

  it('引数なし → cwd を projectRoot として整備する', async () => {
    const cwd = emptyDir();
    seedInstalled(cwd);
    const h = harness({ cwd });

    await runInit(makeCtx([]), h.deps);

    expect(fs.existsSync(path.join(cwd, '.mnemotheca', 'config.json'))).toBe(true);
  });
});

describe('mnemo init — インストール検証(step 3)', () => {
  it('node_modules/mnemo が無い → NOT_INITIALIZED エラーで案内文に npm install 手順を含む', async () => {
    const base = emptyDir();
    const dir = path.join(base, 'my-brain');
    fs.mkdirSync(dir, { recursive: true });
    const h = harness({ cwd: base });

    await expect(runInit(makeCtx(['my-brain']), h.deps)).rejects.toSatisfy((e: unknown) => {
      return (
        isMnemoError(e) &&
        e.code === 'NOT_INITIALIZED' &&
        e.message.includes('npm install') &&
        e.message.includes(MNEMO_GITHUB_SLUG)
      );
    });
  });

  it('node_modules/mnemo/dist/cli/index.js が無い → エラー', async () => {
    const base = emptyDir();
    const dir = path.join(base, 'my-brain');
    seedInstalled(dir);
    fs.rmSync(path.join(dir, 'node_modules', 'mnemo', 'dist', 'cli', 'index.js'));
    const h = harness({ cwd: base });

    await expect(runInit(makeCtx(['my-brain']), h.deps)).rejects.toSatisfy(
      (e: unknown) => isMnemoError(e) && e.code === 'NOT_INITIALIZED',
    );
  });

  it('node_modules/mnemo/dist/mcp/index.js が無い → エラー', async () => {
    const base = emptyDir();
    const dir = path.join(base, 'my-brain');
    seedInstalled(dir);
    fs.rmSync(path.join(dir, 'node_modules', 'mnemo', 'dist', 'mcp', 'index.js'));
    const h = harness({ cwd: base });

    await expect(runInit(makeCtx(['my-brain']), h.deps)).rejects.toSatisfy(
      (e: unknown) => isMnemoError(e) && e.code === 'NOT_INITIALIZED',
    );
  });

  it('検証に成功すれば続行する(骨格が生成される)', async () => {
    const { base, dir, name } = installedTarget();
    const h = harness({ cwd: base });
    await expect(runInit(makeCtx([name]), h.deps)).resolves.toBeUndefined();
    expect(fs.existsSync(path.join(dir, '.mnemotheca', 'config.json'))).toBe(true);
  });
});

describe('mnemo init — step 1 のガード(Node バージョン)', () => {
  it('Node < 20 → 終了(NODE_VERSION_UNSUPPORTED)', async () => {
    const { base, name } = installedTarget();
    const h = harness({ cwd: base, nodeVersion: 'v18.19.1' });

    await expect(runInit(makeCtx([name]), h.deps)).rejects.toSatisfy(
      (e: unknown) => isMnemoError(e) && e.code === 'NODE_VERSION_UNSUPPORTED',
    );
  });
});

describe('mnemo init — 冪等モード', () => {
  it('再実行で config.json のバイト列が不変・vault 非破壊・スニペット再表示', async () => {
    const { base, dir, name } = installedTarget();

    // 1 回目
    await runInit(makeCtx([name]), harness({ cwd: base }).deps);

    // ユーザーがノートを 1 件置く
    const note = path.join(dir, 'vault', 'knowledge', 'note.md');
    fs.writeFileSync(note, '---\ntitle: x\n---\nbody\n');
    const configBytesBefore = fs.readFileSync(path.join(dir, '.mnemotheca', 'config.json'));
    const markerBefore = fs.readFileSync(path.join(dir, 'vault', '.mnemotheca-vault.json'));

    // 2 回目
    const h2 = harness({
      cwd: base,
      now: () => new Date('2027-01-01T00:00:00.000Z'),
    });
    await expect(runInit(makeCtx([name]), h2.deps)).resolves.toBeUndefined();

    expect(fs.readFileSync(path.join(dir, '.mnemotheca', 'config.json'))).toEqual(configBytesBefore);
    expect(fs.readFileSync(path.join(dir, 'vault', '.mnemotheca-vault.json'))).toEqual(markerBefore);
    expect(fs.readFileSync(note, 'utf8')).toBe('---\ntitle: x\n---\nbody\n');
    expect(h2.out()).toContain(buildMcpSnippet(dir).serverKey);
    expect(h2.out()).toContain('冪等');
  });

  it('冪等モードでは既存 vault の .md 検出プロンプトも尊重して続行できる', async () => {
    const { base, dir, name } = installedTarget();
    await runInit(makeCtx([name]), harness({ cwd: base }).deps);
    fs.writeFileSync(path.join(dir, 'vault', 'knowledge', 'a.md'), '# a\n');

    const h = harness({ cwd: base });
    await expect(runInit(makeCtx([name]), h.deps)).resolves.toBeUndefined();
    expect(h.confirmUseExistingVault).toHaveBeenCalledWith(1);
  });
});

describe('mnemo init — 既存ディレクトリ / vault のプロンプト', () => {
  it('vault/knowledge に既存 .md → プロンプトで拒否したら中断', async () => {
    const { base, dir, name } = installedTarget();
    fs.mkdirSync(path.join(dir, 'vault', 'knowledge'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'vault', 'knowledge', 'seed.md'), '# seed\n');

    const h = harness({ cwd: base });
    h.confirmUseExistingVault.mockResolvedValue(false);

    await expect(runInit(makeCtx([name]), h.deps)).rejects.toThrow();
    expect(h.confirmUseExistingVault).toHaveBeenCalledWith(1);
  });

  it('vault/knowledge に既存 .md → プロンプトで承認したら続行', async () => {
    const { base, dir, name } = installedTarget();
    fs.mkdirSync(path.join(dir, 'vault', 'knowledge'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'vault', 'knowledge', 'seed.md'), '# seed\n');

    const h = harness({ cwd: base });
    await runInit(makeCtx([name]), h.deps);

    expect(fs.readFileSync(path.join(dir, 'vault', 'knowledge', 'seed.md'), 'utf8')).toBe('# seed\n');
    expect(fs.existsSync(path.join(dir, '.mnemotheca', 'config.json'))).toBe(true);
  });

  it('非空の既存ディレクトリ(未初期化)→ 確認プロンプト。拒否で中断', async () => {
    const cwd = emptyDir();
    seedInstalled(cwd);
    fs.writeFileSync(path.join(cwd, 'unrelated.txt'), 'hi');
    const h = harness({ cwd });
    h.confirmUseExistingDir.mockResolvedValue(false);

    await expect(runInit(makeCtx([]), h.deps)).rejects.toThrow();
    expect(h.confirmUseExistingDir).toHaveBeenCalled();
  });
});

describe('mnemo init — .gitignore の管理ブロック', () => {
  const BLOCK = [
    '# >>> mnemo (managed by `mnemo init` — edit outside this block) >>>',
    '/*',
    '!/vault/',
    '!/.gitignore',
    '!/.mnemotheca/',
    '/.mnemotheca/index/',
    '/.mnemotheca/snapshots/',
    '# <<< mnemo <<<',
  ].join('\n');

  it('既存 .gitignore の先頭に管理ブロックを挿入し、ユーザー行はブロックの後ろに温存する', async () => {
    const cwd = emptyDir();
    seedInstalled(cwd);
    fs.writeFileSync(path.join(cwd, '.gitignore'), 'node_modules/\ndist/\n');
    const h = harness({ cwd });

    await runInit(makeCtx([]), h.deps);

    expect(fs.readFileSync(path.join(cwd, '.gitignore'), 'utf8')).toBe(
      `${BLOCK}\n\nnode_modules/\ndist/\n`,
    );
  });

  it('再 init は冪等: 管理ブロックの中身が現行版なら書き換えない', async () => {
    const cwd = emptyDir();
    seedInstalled(cwd);
    const h = harness({ cwd });
    await runInit(makeCtx([]), h.deps);
    const first = fs.readFileSync(path.join(cwd, '.gitignore'), 'utf8');
    expect(first).toBe(`${BLOCK}\n`);

    const h2 = harness({ cwd });
    await runInit(makeCtx([]), h2.deps);
    expect(fs.readFileSync(path.join(cwd, '.gitignore'), 'utf8')).toBe(first);
  });

  it('既存の管理ブロックは中身だけ現行版へ置換し、マーカー外は不変', async () => {
    const cwd = emptyDir();
    seedInstalled(cwd);
    fs.writeFileSync(
      path.join(cwd, '.gitignore'),
      [
        '# my rules',
        'secret.txt',
        '',
        '# >>> mnemo (managed by `mnemo init` — edit outside this block) >>>',
        '/* ',
        '!/vault/',
        '# <<< mnemo <<<',
        '',
        '!/notes-backup/',
        '',
      ].join('\n'),
    );
    const h = harness({ cwd });

    await runInit(makeCtx([]), h.deps);

    expect(fs.readFileSync(path.join(cwd, '.gitignore'), 'utf8')).toBe(
      `# my rules\nsecret.txt\n\n${BLOCK}\n\n!/notes-backup/\n`,
    );
  });
});

describe('mnemo init — buildIndex 失敗', () => {
  it('buildIndex が失敗しても warn + 続行(throw しない)', async () => {
    const { base, dir, name } = installedTarget();
    const h = harness({
      cwd: base,
      buildIndex: vi.fn(async () => {
        throw new Error('boom');
      }),
    });

    await expect(runInit(makeCtx([name]), h.deps)).resolves.toBeUndefined();
    expect(h.out()).toMatch(/警告|reindex/);
    expect(fs.existsSync(path.join(dir, '.mnemotheca', 'config.json'))).toBe(true);
  });
});

describe('mnemo init — --json 出力', () => {
  it('スニペットを機械可読で出す(ref フィールドは無い)', async () => {
    const { base, dir, name } = installedTarget();
    const h = harness({ cwd: base });

    await runInit(makeCtx([name], { json: true }), h.deps);

    const parsed = JSON.parse(h.out()) as {
      projectRoot: string;
      serverKey: string;
      snippet: string;
      ref?: unknown;
    };
    expect(parsed.projectRoot).toBe(dir);
    expect(parsed.serverKey).toBe(buildMcpSnippet(dir).serverKey);
    expect(parsed.snippet).toBe(buildMcpSnippet(dir).snippet);
    expect(parsed.ref).toBeUndefined();
  });
});
