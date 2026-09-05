// test/cli/doctor.test.ts — `mnemo doctor [--fix]`(設計 §9-1 doctor 行 / §9-5 / §12-10 / §13-14)。
//
// 実ネットワーク・実 Claude 設定ファイルには一切触れない。Claude 設定探索
// (`discoverClaudeConfigs`)・snippet の node 確認(`snippetCheckDeps`)はすべて注入でスタブする。

import fs from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import {
  run as runDoctor,
  type DoctorDeps,
  type DoctorReport,
} from '../../src/cli/commands/doctor.js';
import { isMnemoError } from '../../src/core/errors.js';
import { projectSlug } from '../../src/core/mcp-snippet.js';
import { runtimePaths } from '../../src/core/paths.js';
import type { CliCommandContext } from '../../src/cli/index.js';
import { makeProject } from '../helpers/project.js';

const roots: string[] = [];

async function mkProject(): Promise<string> {
  const root = await makeProject();
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const d = roots.pop();
    if (d === undefined) continue;
    fs.rmSync(d, { recursive: true, force: true });
    try {
      fs.rmSync(runtimePaths(d).dir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  }
});

// ─────────────────────────── ヘルパ ───────────────────────────

function makeCtx(
  projectRoot: string,
  over: { options?: Record<string, unknown>; global?: Partial<CliCommandContext['global']> } = {},
): CliCommandContext {
  return {
    name: 'doctor',
    args: [],
    options: over.options ?? {},
    global: { project: undefined, json: false, quiet: false, ...over.global },
    projectRoot,
  };
}

function sink(): { lines: string[]; write: (l: string) => void; text: () => string } {
  const lines: string[] = [];
  return { lines, write: (l) => void lines.push(l), text: () => lines.join('\n') };
}

/** 常に注入する土台(実 OS / 実ネットに触れない)。 */
function baseDeps(over: Partial<DoctorDeps> = {}): Partial<DoctorDeps> {
  return {
    discoverClaudeConfigs: () => [],
    nowMs: () => 10_000_000_000_000,
    ...over,
  };
}

/** node_modules/mnemo と meta.json を用意(DIST_MISSING / INDEX_MISSING を黙らせる)。 */
function seedInstalled(root: string): void {
  fs.mkdirSync(`${root}/node_modules/mnemo/dist/cli`, { recursive: true });
  fs.mkdirSync(`${root}/node_modules/mnemo/dist/mcp`, { recursive: true });
  fs.writeFileSync(`${root}/node_modules/mnemo/dist/cli/index.js`, '// cli\n');
  fs.writeFileSync(`${root}/node_modules/mnemo/dist/mcp/index.js`, '// mcp\n');
  fs.writeFileSync(
    `${root}/.mnemotheca/index/meta.json`,
    JSON.stringify({ v: 1, schemaVersion: 1, builtAt: 'x', docs: {} }),
  );
}

/** doctor を走らせ、レポート / 出力行 / throw を返す。 */
async function run(
  root: string,
  opts: {
    fix?: boolean;
    json?: boolean;
    quiet?: boolean;
    deps?: Partial<DoctorDeps>;
  } = {},
): Promise<{ report: DoctorReport | null; out: ReturnType<typeof sink>; threw: unknown }> {
  const out = sink();
  const ctx = makeCtx(root, {
    options: opts.fix ? { fix: true } : {},
    global: { json: opts.json ?? true, quiet: opts.quiet ?? false },
  });
  let threw: unknown = null;
  try {
    await runDoctor(ctx, { ...baseDeps(opts.deps), out: out.write, ...(opts.deps ?? {}) });
  } catch (err) {
    threw = err;
  }
  let report: DoctorReport | null = null;
  const last = out.lines[out.lines.length - 1];
  if ((opts.json ?? true) && last !== undefined) {
    try {
      report = JSON.parse(last) as DoctorReport;
    } catch {
      report = null;
    }
  }
  return { report, out, threw };
}

function findCheck(report: DoctorReport | null, id: string): DoctorReport['checks'][number] | undefined {
  return report?.checks.find((c) => c.id === id);
}

// ═══════════════════════════ 基本 ═══════════════════════════

describe('mnemo doctor — 基本', () => {
  it('健全なプロジェクト: 問題なし・exit 0', async () => {
    const root = await mkProject();
    seedInstalled(root);
    const { report, threw } = await run(root);
    expect(threw).toBeNull();
    expect(report?.ok).toBe(true);
    // 未設定(#8)だけは info で出る
    const problems = report?.checks.filter((c) => c.severity !== 'info') ?? [];
    expect(problems).toEqual([]);
  });

  it('projectRoot を解決できない → NOT_INITIALIZED', async () => {
    const out = sink();
    const ctx = makeCtx(undefined as unknown as string, { global: { json: true } });
    (ctx as { projectRoot: string | undefined }).projectRoot = undefined;
    const err = await runDoctor(ctx, {
      ...baseDeps(),
      resolveProjectRoot: () => null,
      out: out.write,
    }).catch((e: unknown) => e);
    expect(isMnemoError(err) && err.code).toBe('NOT_INITIALIZED');
  });

  it('壊れた config.json → error・exit 1', async () => {
    const root = await mkProject();
    seedInstalled(root);
    fs.writeFileSync(`${root}/.mnemotheca/config.json`, '{ not json');
    const { report, threw } = await run(root);
    expect(isMnemoError(threw) && threw.code).toBe('CONFIG_CORRUPT');
    expect(findCheck(report, 'CONFIG_CORRUPT')?.severity).toBe('error');
  });

  it('Node < 20 → warn・exit 0', async () => {
    const root = await mkProject();
    seedInstalled(root);
    const { report, threw } = await run(root, { deps: { nodeVersion: 'v18.20.0' } });
    expect(threw).toBeNull();
    expect(findCheck(report, 'NODE_VERSION')?.severity).toBe('warn');
  });

  it('yarn PnP レイアウト検出 → warn', async () => {
    const root = await mkProject();
    seedInstalled(root);
    fs.writeFileSync(`${root}/.pnp.cjs`, '// pnp\n');
    const { report } = await run(root);
    expect(findCheck(report, 'PNP_LAYOUT')?.severity).toBe('warn');
  });

  it('parse-errors.json / conflicts.json の一覧を warn で報告', async () => {
    const root = await mkProject();
    seedInstalled(root);
    fs.writeFileSync(
      `${root}/.mnemotheca/index/parse-errors.json`,
      JSON.stringify([{ path: 'knowledge/a.md', detectedAt: 'x', message: 'bad', kind: 'schema' }]),
    );
    fs.writeFileSync(
      `${root}/.mnemotheca/index/conflicts.json`,
      JSON.stringify([{ path: 'knowledge/b.md', detectedAt: 'x', reason: 'dup' }]),
    );
    const { report } = await run(root);
    expect(findCheck(report, 'PARSE_ERRORS')?.paths).toEqual(['knowledge/a.md']);
    expect(findCheck(report, 'CONFLICTS')?.paths).toEqual(['knowledge/b.md']);
  });

  it('meta.json 不在 → INDEX_MISSING info(exit 0)', async () => {
    const root = await mkProject();
    fs.mkdirSync(`${root}/node_modules/mnemo/dist/cli`, { recursive: true });
    fs.mkdirSync(`${root}/node_modules/mnemo/dist/mcp`, { recursive: true });
    fs.writeFileSync(`${root}/node_modules/mnemo/dist/cli/index.js`, '// cli\n');
    fs.writeFileSync(`${root}/node_modules/mnemo/dist/mcp/index.js`, '// mcp\n');
    const { report, threw } = await run(root);
    expect(threw).toBeNull();
    expect(findCheck(report, 'INDEX_MISSING')?.severity).toBe('info');
  });
});

// ═══════════════════════════ DIST_MISSING ═══════════════════════════

describe('mnemo doctor — DIST_MISSING', () => {
  it('node_modules/mnemo が揃っている → 何も出さない', async () => {
    const root = await mkProject();
    seedInstalled(root);
    const { report, threw } = await run(root);
    expect(threw).toBeNull();
    expect(findCheck(report, 'DIST_MISSING')).toBeUndefined();
    expect(report?.dist).toEqual({ present: true });
  });

  it('node_modules/mnemo が欠落 → DIST_MISSING(error)', async () => {
    const root = await mkProject();
    const { report, threw } = await run(root);
    expect(isMnemoError(threw)).toBe(true);
    const c = findCheck(report, 'DIST_MISSING');
    expect(c?.severity).toBe('error');
    expect(c?.message).toContain('npm install');
    expect(c?.fixable).toBe(false);
    expect(report?.dist).toEqual({ present: false });
  });

  it('--fix でも npm install はしない(DIST_MISSING は非 fixable・node_modules/mnemo 不変)', async () => {
    const root = await mkProject();
    const { report } = await run(root, { fix: true });
    const c = findCheck(report, 'DIST_MISSING');
    expect(c?.fixable).toBe(false);
    expect(c?.fixed).toBeUndefined();
    expect(fs.existsSync(`${root}/node_modules/mnemo`)).toBe(false);
  });
});

// ═══════════════════════════ 中断 organize(§12-10 / §13-14) ═══════════════════════════

describe('mnemo doctor — 中断 organize', () => {
  it('applying:true → 報告のみ(exit 0)', async () => {
    const root = await mkProject();
    seedInstalled(root);
    fs.writeFileSync(
      `${root}/.mnemotheca/index/organize-session.json`,
      JSON.stringify({ v: 1, applying: true, snapshotId: 'org-x', scannedAt: '2026-09-01T00:00:00+09:00' }),
    );
    const { report, threw } = await run(root);
    expect(threw).toBeNull();
    const c = findCheck(report, 'ORGANIZE_INTERRUPTED');
    expect(c?.severity).toBe('warn');
    expect(c?.fixable).toBe(false);
    expect(c?.message).toContain('org-x');
    expect(c?.message).toContain('前回の整理を取り消して');
    expect(report?.organizeInterrupted).toEqual({ snapshotId: 'org-x', since: '2026-09-01T00:00:00+09:00' });
  });

  it('--fix でも organize-session.json のバイト列は不変', async () => {
    const root = await mkProject();
    seedInstalled(root);
    const p = `${root}/.mnemotheca/index/organize-session.json`;
    const bytes = JSON.stringify({ v: 1, applying: true, snapshotId: 'org-x', scannedAt: '2026-09-01T00:00:00+09:00' });
    fs.writeFileSync(p, bytes);
    await run(root, { fix: true });
    expect(fs.readFileSync(p, 'utf8')).toBe(bytes);
  });

  it('applying:false / ファイル無し → 何も報告しない', async () => {
    const root = await mkProject();
    seedInstalled(root);
    const { report: r1 } = await run(root);
    expect(findCheck(r1, 'ORGANIZE_INTERRUPTED')).toBeUndefined();

    fs.writeFileSync(
      `${root}/.mnemotheca/index/organize-session.json`,
      JSON.stringify({ v: 1, applying: false, snapshotId: null }),
    );
    const { report: r2 } = await run(root);
    expect(findCheck(r2, 'ORGANIZE_INTERRUPTED')).toBeUndefined();
  });
});

// ═══════════════════════════ SNIPPET_STALE 8 条件(§9-5 / §13-14) ═══════════════════════════

describe('mnemo doctor — SNIPPET_STALE', () => {
  function serverKey(root: string): string {
    return `mnemotheca-${projectSlug(root)}`;
  }
  function entryPath(root: string): string {
    return `${fs.realpathSync.native(root)}/node_modules/mnemo/dist/mcp/index.js`;
  }
  /** 現在値どおり(陳腐化なし)のエントリ。 */
  function goodEntry(root: string): Record<string, unknown> {
    return {
      command: process.execPath,
      args: [entryPath(root)],
      env: { MNEMO_PROJECT: fs.realpathSync.native(root) },
    };
  }
  function withConfig(
    servers: Record<string, unknown>,
    snippetCheckDeps: DoctorDeps['snippetCheckDeps'] = {},
  ): Partial<DoctorDeps> {
    return {
      discoverClaudeConfigs: () => [{ path: '/fake/claude_desktop_config.json', mcpServers: servers }],
      snippetCheckDeps: {
        fileExists: () => true,
        readNodeVersion: () => 'v20.11.0',
        ...snippetCheckDeps,
      },
    };
  }

  it('#1 旧キー "mnemotheca"', async () => {
    const root = await mkProject();
    seedInstalled(root);
    const { report, threw } = await run(root, { deps: withConfig({ mnemotheca: goodEntry(root) }) });
    expect(threw).toBeNull();
    expect(findCheck(report, 'SNIPPET_STALE#1')?.severity).toBe('warn');
  });

  it('#2 command が "node"', async () => {
    const root = await mkProject();
    seedInstalled(root);
    const { report } = await run(root, {
      deps: withConfig({ [serverKey(root)]: { ...goodEntry(root), command: 'node' } }),
    });
    expect(findCheck(report, 'SNIPPET_STALE#2')?.severity).toBe('warn');
  });

  it('#3 実在するが別の絶対パス(warn・error ではない)', async () => {
    const root = await mkProject();
    seedInstalled(root);
    const { report, threw } = await run(root, {
      deps: withConfig({ [serverKey(root)]: { ...goodEntry(root), command: '/opt/other/bin/node' } }),
    });
    expect(threw).toBeNull();
    const c = findCheck(report, 'SNIPPET_STALE#3');
    expect(c?.severity).toBe('warn');
    expect(findCheck(report, 'SNIPPET_STALE#4')).toBeUndefined();
  });

  it('#4 存在しない絶対パス', async () => {
    const root = await mkProject();
    seedInstalled(root);
    const { report } = await run(root, {
      deps: withConfig(
        { [serverKey(root)]: { ...goodEntry(root), command: '/nope/node' } },
        { fileExists: () => false },
      ),
    });
    expect(findCheck(report, 'SNIPPET_STALE#4')?.severity).toBe('warn');
  });

  it('#5 args[0] が別 projectRoot', async () => {
    const root = await mkProject();
    seedInstalled(root);
    const { report } = await run(root, {
      deps: withConfig({ [serverKey(root)]: { ...goodEntry(root), args: ['/elsewhere/dist/mcp/index.js'] } }),
    });
    expect(findCheck(report, 'SNIPPET_STALE#5')?.severity).toBe('warn');
  });

  it('#6 env.MNEMO_PROJECT 欠落', async () => {
    const root = await mkProject();
    seedInstalled(root);
    const e = goodEntry(root);
    delete e['env'];
    const { report } = await run(root, { deps: withConfig({ [serverKey(root)]: e }) });
    expect(findCheck(report, 'SNIPPET_STALE#6')?.severity).toBe('warn');
  });

  it('#7 スニペット node が v20 未満', async () => {
    const root = await mkProject();
    seedInstalled(root);
    const { report } = await run(root, {
      deps: withConfig(
        { [serverKey(root)]: { ...goodEntry(root), command: '/opt/n18/bin/node' } },
        { fileExists: () => true, readNodeVersion: () => 'v18.19.0' },
      ),
    });
    expect(findCheck(report, 'SNIPPET_STALE#7')?.severity).toBe('warn');
  });

  it('#8 設定ファイルなし → info(stale 扱いにしない・exit 0)', async () => {
    const root = await mkProject();
    seedInstalled(root);
    const { report, threw } = await run(root, { deps: { discoverClaudeConfigs: () => [] } });
    expect(threw).toBeNull();
    expect(findCheck(report, 'SNIPPET_STALE#8')?.severity).toBe('info');
  });

  it('末尾に現在値スニペットを表示 / --json に snippetStale', async () => {
    const root = await mkProject();
    seedInstalled(root);
    const { report } = await run(root, { deps: { discoverClaudeConfigs: () => [] } });
    expect(report?.snippetStale?.serverKey).toBe(serverKey(root));
    expect(report?.snippetStale?.currentSnippet).toContain('"mcpServers"');

    const human = await run(root, { json: false, deps: { discoverClaudeConfigs: () => [] } });
    expect(human.out.text()).toContain('"mcpServers"');
    expect(human.out.text()).toContain(serverKey(root));
  });

  it('--fix でも Claude 設定ファイルのバイト列は不変', async () => {
    const root = await mkProject();
    seedInstalled(root);
    const cfgPath = `${root}/claude_desktop_config.json`;
    const bytes = JSON.stringify({ mcpServers: { mnemotheca: goodEntry(root) } }, null, 2);
    fs.writeFileSync(cfgPath, bytes);
    await run(root, {
      fix: true,
      deps: {
        discoverClaudeConfigs: () => {
          const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as { mcpServers: Record<string, unknown> };
          return [{ path: cfgPath, mcpServers: parsed.mcpServers }];
        },
        snippetCheckDeps: { fileExists: () => true, readNodeVersion: () => 'v20.0.0' },
      },
    });
    expect(fs.readFileSync(cfgPath, 'utf8')).toBe(bytes);
  });
});

// ═══════════════════════════ 検出 + --fix 修復 ═══════════════════════════

describe('mnemo doctor — 検出 + --fix', () => {
  it('vault マーカー欠落 → warn / --fix で再生成', async () => {
    const root = await mkProject();
    seedInstalled(root);
    fs.rmSync(`${root}/vault/.mnemotheca-vault.json`);
    const { report: r1 } = await run(root);
    expect(findCheck(r1, 'VAULT_MARKER_MISSING')?.severity).toBe('warn');

    const { report: r2, threw } = await run(root, { fix: true });
    expect(threw).toBeNull();
    expect(findCheck(r2, 'VAULT_MARKER_MISSING')?.fixed).toBe(true);
    expect(fs.existsSync(`${root}/vault/.mnemotheca-vault.json`)).toBe(true);
  });

  it('vault ディレクトリ欠落 → error / --fix で再作成し exit 0 に回復', async () => {
    const root = await mkProject();
    seedInstalled(root);
    fs.rmSync(`${root}/vault`, { recursive: true, force: true });
    const { threw: t1 } = await run(root);
    expect(isMnemoError(t1) && t1.code).toBe('VAULT_UNAVAILABLE');

    const { report, threw: t2 } = await run(root, { fix: true });
    expect(t2).toBeNull();
    expect(findCheck(report, 'VAULT_MISSING')?.fixed).toBe(true);
    expect(fs.existsSync(`${root}/vault/knowledge`)).toBe(true);
    expect(fs.existsSync(`${root}/vault/categories`)).toBe(true);
  });

  it('vault/ はあるが vault/knowledge/ 欠落 → warn / --fix で mkdir・冪等', async () => {
    const root = await mkProject();
    seedInstalled(root);
    fs.rmSync(`${root}/vault/knowledge`, { recursive: true, force: true });

    const { report: r1, threw: t1 } = await run(root);
    expect(t1).toBeNull();
    const c1 = findCheck(r1, 'VAULT_SUBDIR_MISSING');
    expect(c1?.severity).toBe('warn');
    expect(c1?.fixable).toBe(true);
    expect(c1?.paths).toEqual([`${root}/vault/knowledge`]);

    const { report: r2, threw: t2 } = await run(root, { fix: true });
    expect(t2).toBeNull();
    expect(findCheck(r2, 'VAULT_SUBDIR_MISSING')?.fixed).toBe(true);
    expect(fs.statSync(`${root}/vault/knowledge`).isDirectory()).toBe(true);

    // 冪等: 再実行で検出されない
    const { report: r3 } = await run(root);
    expect(findCheck(r3, 'VAULT_SUBDIR_MISSING')).toBeUndefined();
  });

  it('usage_log 末尾破損 → warn / --fix で切り詰め', async () => {
    const root = await mkProject();
    seedInstalled(root);
    const p = `${root}/.mnemotheca/index/usage_log.jsonl`;
    fs.writeFileSync(p, '{"v":1,"ts":"a","mode":"store","event":"x","ok":true}\n{"v":1,"ts":"b"');
    const { report: r1 } = await run(root);
    expect(findCheck(r1, 'USAGE_LOG_TAIL')?.severity).toBe('warn');

    const { report: r2 } = await run(root, { fix: true });
    expect(findCheck(r2, 'USAGE_LOG_TAIL')?.fixed).toBe(true);
    expect(fs.readFileSync(p, 'utf8').endsWith('\n')).toBe(true);
    expect(fs.readFileSync(p, 'utf8')).not.toContain('"ts":"b"');
  });

  it('stale ロック → warn / --fix で削除', async () => {
    const root = await mkProject();
    seedInstalled(root);
    const locksDir = runtimePaths(root).locksDir;
    fs.mkdirSync(`${locksDir}/knowledge.lock`, { recursive: true });
    const old = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(`${locksDir}/knowledge.lock`, old, old);

    const { report: r1 } = await run(root);
    const c1 = findCheck(r1, 'STALE_LOCK');
    expect(c1?.severity).toBe('warn');
    expect(c1?.paths).toEqual([`${locksDir}/knowledge.lock`]);

    const { report: r2 } = await run(root, { fix: true });
    expect(findCheck(r2, 'STALE_LOCK')?.fixed).toBe(true);
    expect(fs.existsSync(`${locksDir}/knowledge.lock`)).toBe(false);
  });

  it('新しいロックは stale 扱いしない', async () => {
    const root = await mkProject();
    seedInstalled(root);
    const locksDir = runtimePaths(root).locksDir;
    fs.mkdirSync(`${locksDir}/knowledge.lock`, { recursive: true });
    const { report } = await run(root, { deps: { nowMs: () => Date.now() } });
    expect(findCheck(report, 'STALE_LOCK')).toBeUndefined();
  });

  it('ランタイムディレクトリのモードが 0700 でない → warn / --fix で chmod 0700', async () => {
    if (process.platform === 'win32') return;
    const root = await mkProject();
    seedInstalled(root);
    const dir = runtimePaths(root).dir;
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o777);

    const { report: r1 } = await run(root);
    expect(findCheck(r1, 'RUNTIME_DIR_MODE')?.severity).toBe('warn');

    const { report: r2 } = await run(root, { fix: true });
    expect(findCheck(r2, 'RUNTIME_DIR_MODE')?.fixed).toBe(true);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('--fix サマリを人間向け出力に含める', async () => {
    const root = await mkProject();
    seedInstalled(root);
    fs.rmSync(`${root}/vault/.mnemotheca-vault.json`);
    const { out } = await run(root, { fix: true, json: false });
    expect(out.text()).toContain('修復しました');
    expect(out.text()).toMatch(/--fix: \d+ 件修復/);
  });
});
