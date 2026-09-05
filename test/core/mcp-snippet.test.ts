import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildMcpSnippet,
  checkSnippetStale,
  type ClaudeConfig,
  projectSlug,
} from '../../src/core/mcp-snippet.js';

const tmpRoots: string[] = [];

/** mkdtemp した使い捨てディレクトリ(実体パス)。afterEach で消す。 */
function mkTmp(prefix = 'mnemo-snip-'): string {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpRoots.push(d);
  return d;
}

/** `<parent>/<name>` ディレクトリを作って実体パスを返す。 */
function mkChild(parent: string, name: string): string {
  const d = path.join(parent, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

afterEach(() => {
  while (tmpRoots.length > 0) {
    const d = tmpRoots.pop();
    if (!d) continue;
    fs.rmSync(d, { recursive: true, force: true });
  }
});

const expectedEntryPath = (root: string): string =>
  path.join(fs.realpathSync.native(root), 'node_modules', 'mnemo', 'dist', 'mcp', 'index.js');

/** buildMcpSnippet が生成する正しいエントリ(checkSnippetStale の good ケース用)。 */
function canonicalEntry(root: string): Record<string, unknown> {
  const { serverKey, snippet } = buildMcpSnippet(root);
  const parsed = JSON.parse(snippet) as { mcpServers: Record<string, Record<string, unknown>> };
  return parsed.mcpServers[serverKey] as Record<string, unknown>;
}

// ===========================================================================
// buildMcpSnippet
// ===========================================================================
describe('buildMcpSnippet', () => {
  it('produces the 3-piece set: command=process.execPath, absolute args entry, env.MNEMO_PROJECT=realpath', () => {
    const root = mkTmp();
    const { serverKey, snippet } = buildMcpSnippet(root);
    const obj = JSON.parse(snippet) as {
      mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    };
    const entry = obj.mcpServers[serverKey];
    expect(entry).toBeDefined();
    expect(entry?.command).toBe(process.execPath);
    expect(entry?.args).toEqual([expectedEntryPath(root)]);
    expect(path.isAbsolute(entry?.args[0] ?? '')).toBe(true);
    expect(entry?.env.MNEMO_PROJECT).toBe(fs.realpathSync.native(root));
  });

  it('bases every absolute path on realpath(projectRoot), not the passed-in path', () => {
    const root = mkTmp();
    const nested = mkChild(root, 'sub');
    // realpath 起点なので nested を渡しても root ではなく nested 実体基準
    const { serverKey, snippet } = buildMcpSnippet(nested);
    const entry = (JSON.parse(snippet) as { mcpServers: Record<string, { env: Record<string, string> }> })
      .mcpServers[serverKey];
    expect(entry?.env.MNEMO_PROJECT).toBe(fs.realpathSync.native(nested));
  });

  it('args[0] points at <projectRoot>/node_modules/mnemo/dist/mcp/index.js', () => {
    const root = mkTmp();
    const { serverKey, snippet } = buildMcpSnippet(root);
    const arg0 = (JSON.parse(snippet) as { mcpServers: Record<string, { args: string[] }> })
      .mcpServers[serverKey]?.args[0] as string;
    expect(arg0.endsWith(path.join('node_modules', 'mnemo', 'dist', 'mcp', 'index.js'))).toBe(true);
  });

  it('serverKey does not collide for two different projectRoots that share the same basename', () => {
    const a = mkChild(mkTmp(), 'my-brain');
    const b = mkChild(mkTmp(), 'my-brain');
    const ka = buildMcpSnippet(a).serverKey;
    const kb = buildMcpSnippet(b).serverKey;
    expect(ka).toMatch(/^mnemotheca-my-brain-[0-9a-f]{6}$/);
    expect(kb).toMatch(/^mnemotheca-my-brain-[0-9a-f]{6}$/);
    expect(ka).not.toBe(kb);
  });

  it('resolves through a symlinked projectRoot to the same key / args / env (real path basis)', () => {
    const root = mkChild(mkTmp(), 'real-brain');
    const link = path.join(mkTmp(), 'linked-brain');
    fs.symlinkSync(root, link);

    const viaReal = buildMcpSnippet(root);
    const viaLink = buildMcpSnippet(link);
    expect(viaLink.serverKey).toBe(viaReal.serverKey);
    expect(viaLink.snippet).toBe(viaReal.snippet);
  });

  it('client option only changes filename; JSON structure is identical', () => {
    const root = mkTmp();
    const desktop = buildMcpSnippet(root); // 既定
    const code = buildMcpSnippet(root, { client: 'code' });
    expect(desktop.filename).toBe('claude_desktop_config.json');
    expect(code.filename).toBe('.mcp.json');
    expect(JSON.parse(code.snippet)).toEqual(JSON.parse(desktop.snippet));
  });

  it('JSON.stringify round-trips Windows-style backslash / spaced paths', () => {
    // 設計 §13-12a: バックスラッシュ・スペース入りパスのエスケープは JSON.stringify に一任。
    const winPath = 'C:\\Users\\John Doe\\projects\\my-brain';
    const obj = {
      mcpServers: {
        'mnemotheca-my-brain-a1b2c3': {
          command: 'C:\\Users\\John Doe\\AppData\\Roaming\\nvm\\v20.17.0\\node.exe',
          args: [`${winPath}\\node_modules\\mnemo\\dist\\mcp\\index.js`],
          env: { MNEMO_PROJECT: winPath },
        },
      },
    };
    const json = JSON.stringify(obj, null, 2);
    expect(json).toContain('C:\\\\Users\\\\John Doe');
    expect(JSON.parse(json)).toEqual(obj);
  });

  it('snippet is JSON with a single mnemotheca-<slug> key and JSON.stringify(obj,null,2) shape', () => {
    const root = mkTmp();
    const { serverKey, snippet } = buildMcpSnippet(root);
    expect(snippet).toBe(JSON.stringify(JSON.parse(snippet), null, 2));
    expect(Object.keys((JSON.parse(snippet) as { mcpServers: object }).mcpServers)).toEqual([
      serverKey,
    ]);
  });
});

// ===========================================================================
// projectSlug
// ===========================================================================
describe('projectSlug', () => {
  const hash6 = (root: string): string =>
    createHash('sha256').update(fs.realpathSync.native(root)).digest('hex').slice(0, 6);

  it('always suffixes -<projectHash first 6 hex>', () => {
    const root = mkChild(mkTmp(), 'my-brain');
    expect(projectSlug(root)).toBe(`my-brain-${hash6(root)}`);
  });

  it('transliterates a Japanese basename to the hash-only form', () => {
    const root = mkChild(mkTmp(), '第二の脳');
    const slug = projectSlug(root);
    expect(slug).toBe(`p-${hash6(root)}`);
  });

  it('prefixes p when the basename starts with a digit', () => {
    const root = mkChild(mkTmp(), '2024-notes');
    expect(projectSlug(root)).toBe(`p2024-notes-${hash6(root)}`);
  });

  it('prefixes p when the basename is symbols only (slug becomes empty)', () => {
    const root = mkChild(mkTmp(), '!!!___!!!');
    expect(projectSlug(root)).toBe(`p-${hash6(root)}`);
  });

  it('truncates the slug body to 24 chars but keeps the hash suffix', () => {
    const longName = 'this-is-a-really-long-project-directory-name';
    const root = mkChild(mkTmp(), longName);
    const slug = projectSlug(root);
    const [, body] = /^(.+)-[0-9a-f]{6}$/.exec(slug) ?? [];
    expect(body).toBe(longName.slice(0, 24));
    expect(body?.length).toBeLessThanOrEqual(24);
    expect(slug.endsWith(`-${hash6(root)}`)).toBe(true);
  });

  it('is stable through a symlinked projectRoot (real path basis)', () => {
    const root = mkChild(mkTmp(), 'sym-brain');
    const link = path.join(mkTmp(), 'sym-link');
    fs.symlinkSync(root, link);
    expect(projectSlug(link)).toBe(projectSlug(root));
  });
});

// ===========================================================================
// checkSnippetStale — §9-5 の 8 条件を各個
// ===========================================================================
describe('checkSnippetStale', () => {
  const okDeps = { fileExists: () => true, readNodeVersion: () => 'v20.11.0' };

  /** 1 エントリだけを持つ Claude 設定を作る。 */
  function cfg(key: string, entry: unknown): ClaudeConfig {
    return { path: 'claude_desktop_config.json', mcpServers: { [key]: entry } };
  }

  it('returns [] when the registered entry matches the current snippet exactly', () => {
    const root = mkTmp();
    const { serverKey } = buildMcpSnippet(root);
    const checks = checkSnippetStale([cfg(serverKey, canonicalEntry(root))], root, okDeps);
    expect(checks).toEqual([]);
  });

  it('#1 flags a legacy "mnemotheca" key', () => {
    const root = mkTmp();
    const checks = checkSnippetStale([cfg('mnemotheca', canonicalEntry(root))], root, okDeps);
    expect(checks.map((c) => c.id)).toContain(1);
    expect(checks.find((c) => c.id === 1)?.severity).toBe('warn');
  });

  it('#2 flags a non-absolute command ("node")', () => {
    const root = mkTmp();
    const { serverKey } = buildMcpSnippet(root);
    const entry = { ...canonicalEntry(root), command: 'node' };
    const checks = checkSnippetStale([cfg(serverKey, entry)], root, okDeps);
    expect(checks.map((c) => c.id)).toContain(2);
    expect(checks.map((c) => c.id)).not.toContain(3);
  });

  it('#3 flags an absolute command that differs from the current process.execPath', () => {
    const root = mkTmp();
    const { serverKey } = buildMcpSnippet(root);
    const entry = { ...canonicalEntry(root), command: path.join(path.sep, 'opt', 'homebrew', 'bin', 'node') };
    const checks = checkSnippetStale([cfg(serverKey, entry)], root, okDeps);
    const ids = checks.map((c) => c.id);
    expect(ids).toContain(3);
    expect(ids).not.toContain(4); // fileExists=true
    expect(ids).not.toContain(7); // readNodeVersion=v20
  });

  it('#4 flags a command path that does not exist on disk', () => {
    const root = mkTmp();
    const { serverKey } = buildMcpSnippet(root);
    const missing = path.join(mkTmp(), 'gone', 'node');
    const entry = { ...canonicalEntry(root), command: missing };
    // real fs.existsSync / spawnSync path (no fileExists override)
    const checks = checkSnippetStale([cfg(serverKey, entry)], root, {
      readNodeVersion: () => null,
    });
    expect(checks.map((c) => c.id)).toContain(4);
  });

  it('#5 flags an args[0] that no longer matches the current MCP entry path', () => {
    const root = mkTmp();
    const { serverKey } = buildMcpSnippet(root);
    const entry = { ...canonicalEntry(root), args: [path.join(path.sep, 'old', 'place', 'index.js')] };
    const checks = checkSnippetStale([cfg(serverKey, entry)], root, okDeps);
    expect(checks.map((c) => c.id)).toContain(5);
  });

  it('#6 flags a missing or mismatched env.MNEMO_PROJECT', () => {
    const root = mkTmp();
    const { serverKey } = buildMcpSnippet(root);

    const missing = { ...canonicalEntry(root), env: {} };
    expect(checkSnippetStale([cfg(serverKey, missing)], root, okDeps).map((c) => c.id)).toContain(6);

    const wrong = { ...canonicalEntry(root), env: { MNEMO_PROJECT: path.join(path.sep, 'somewhere', 'else') } };
    expect(checkSnippetStale([cfg(serverKey, wrong)], root, okDeps).map((c) => c.id)).toContain(6);
  });

  it('#7 flags a snippet node whose --version is below v20 (spawnSync stubbed)', () => {
    const root = mkTmp();
    const { serverKey } = buildMcpSnippet(root);
    const entry = { ...canonicalEntry(root), command: path.join(path.sep, 'opt', 'node18', 'bin', 'node') };
    const checks = checkSnippetStale([cfg(serverKey, entry)], root, {
      fileExists: () => true,
      readNodeVersion: () => 'v18.19.0',
    });
    const check7 = checks.find((c) => c.id === 7);
    expect(check7).toBeDefined();
    expect(check7?.severity).toBe('warn');
  });

  it('#8 reports info when no Claude config has an entry for this project', () => {
    const root = mkTmp();
    const empty = checkSnippetStale([], root, okDeps);
    expect(empty).toHaveLength(1);
    expect(empty[0]?.id).toBe(8);
    expect(empty[0]?.severity).toBe('info');

    // 設定はあるが別プロジェクトのキーしか無い場合も #8
    const other = checkSnippetStale([cfg('mnemotheca-other-abc123', canonicalEntry(root))], root, okDeps);
    expect(other.map((c) => c.id)).toEqual([8]);
  });

  it('all checks carry exit-0 severities (warn/info only) and never mutate input', () => {
    const root = mkTmp();
    const { serverKey } = buildMcpSnippet(root);
    const entry = { ...canonicalEntry(root), command: 'node', args: ['x'], env: {} };
    const config = cfg(serverKey, entry);
    const frozen = JSON.stringify(config);
    const checks = checkSnippetStale([config], root, okDeps);
    expect(checks.length).toBeGreaterThan(0);
    for (const c of checks) {
      expect(['warn', 'info']).toContain(c.severity);
    }
    expect(JSON.stringify(config)).toBe(frozen);
  });
});
