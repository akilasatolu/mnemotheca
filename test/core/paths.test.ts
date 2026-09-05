import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isMnemoError } from '../../src/core/errors.js';
import {
  ensureRuntimeDir,
  findConfigAnchor,
  mnemothecaPaths,
  normalizePath,
  projectHash,
  resolveProjectRoot,
  resolveProjectRootForInit,
  runtimeBase,
  runtimePaths,
  vaultPaths,
} from '../../src/core/paths.js';
import { makeProject } from '../helpers/project.js';

const IS_WIN = process.platform === 'win32';
const HAS_UID = typeof process.getuid === 'function';

const tmpRoots: string[] = [];

/** mkdtemp した使い捨てディレクトリ(実体パス)。afterEach で消す。 */
function mkTmp(prefix = 'mnemo-paths-'): string {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpRoots.push(d);
  return d;
}

async function mkProject(): Promise<string> {
  const root = fs.realpathSync.native(await makeProject());
  tmpRoots.push(root);
  return root;
}

// 環境変数の保存・復元
let savedEnv: Record<string, string | undefined>;
const ENV_KEYS = ['MNEMO_PROJECT', 'MNEMO_RUNTIME_DIR', 'XDG_RUNTIME_DIR'] as const;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  while (tmpRoots.length > 0) {
    const d = tmpRoots.pop();
    if (!d) continue;
    try {
      fs.chmodSync(d, 0o700);
    } catch {
      /* ignore */
    }
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function withPlatform(value: NodeJS.Platform, fn: () => void): void {
  const desc = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value, configurable: true });
  try {
    fn();
  } finally {
    if (desc) Object.defineProperty(process, 'platform', desc);
  }
}

// ---------------------------------------------------------------------------
// findConfigAnchor
// ---------------------------------------------------------------------------
describe('findConfigAnchor', () => {
  it('walks parent dirs and returns the projectRoot holding .mnemotheca/config.json', async () => {
    const root = await mkProject();
    const start = path.join(root, 'a', 'b', 'c');
    fs.mkdirSync(start, { recursive: true });
    expect(findConfigAnchor(start)).toBe(root);
  });

  it('returns null when no anchor exists up to the filesystem root', () => {
    const lonely = mkTmp();
    expect(findConfigAnchor(lonely)).toBeNull();
  });

  it('reaches the projectRoot from a pnpm-style deep node_modules path', async () => {
    const root = await mkProject();
    const deep = path.join(
      root,
      'node_modules',
      '.pnpm',
      'mnemo@1.0.0',
      'node_modules',
      'mnemo',
      'dist',
      'mcp',
    );
    fs.mkdirSync(deep, { recursive: true });
    expect(findConfigAnchor(deep)).toBe(root);
  });

  it('resolves through a symlinked start dir to the real projectRoot', async () => {
    const root = await mkProject();
    const real = path.join(root, 'node_modules', 'mnemo', 'dist', 'mcp');
    fs.mkdirSync(real, { recursive: true });
    const link = path.join(mkTmp(), 'linked-mcp');
    fs.symlinkSync(real, link);
    expect(findConfigAnchor(link)).toBe(root);
  });

  it('accepts a file path as startDir (walks from its directory)', async () => {
    const root = await mkProject();
    const file = path.join(root, 'sub', 'x.js');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    expect(findConfigAnchor(file)).toBe(root);
  });
});

// ---------------------------------------------------------------------------
// resolveProjectRoot / resolveProjectRootForInit
// ---------------------------------------------------------------------------
describe('resolveProjectRoot', () => {
  it('prefers projectFlag over anchor search', async () => {
    const flagRoot = await mkProject();
    const cwdRoot = await mkProject();
    const start = path.join(cwdRoot, 'nested');
    fs.mkdirSync(start);
    expect(resolveProjectRoot({ projectFlag: flagRoot, startDir: start })).toBe(flagRoot);
  });

  it('prefers MNEMO_PROJECT over anchor search, and projectFlag over MNEMO_PROJECT', async () => {
    const envRoot = await mkProject();
    const flagRoot = await mkProject();
    const cwdRoot = await mkProject();
    process.env.MNEMO_PROJECT = envRoot;
    expect(resolveProjectRoot({ startDir: cwdRoot })).toBe(envRoot);
    expect(resolveProjectRoot({ startDir: cwdRoot, projectFlag: flagRoot })).toBe(flagRoot);
  });

  it('throws NOT_INITIALIZED when the override target has no .mnemotheca/config.json', () => {
    const bare = mkTmp();
    process.env.MNEMO_PROJECT = bare;
    try {
      resolveProjectRoot();
      expect.unreachable();
    } catch (e) {
      expect(isMnemoError(e) && e.code).toBe('NOT_INITIALIZED');
    }
  });

  it('throws NOT_INITIALIZED when anchor search finds nothing', () => {
    const lonely = mkTmp();
    try {
      resolveProjectRoot({ startDir: lonely });
      expect.unreachable();
    } catch (e) {
      expect(isMnemoError(e) && e.code).toBe('NOT_INITIALIZED');
    }
  });

  it('resolves via anchor search when no override is set', async () => {
    const root = await mkProject();
    const start = path.join(root, 'deep', 'dir');
    fs.mkdirSync(start, { recursive: true });
    expect(resolveProjectRoot({ startDir: start })).toBe(root);
  });
});

describe('resolveProjectRootForInit', () => {
  it('absolutizes without any search or config.json check', () => {
    const abs = mkTmp();
    expect(resolveProjectRootForInit(abs)).toBe(path.resolve(abs));
    // 実在しない相対パスでも throw しない
    const rel = resolveProjectRootForInit('some/new/project');
    expect(path.isAbsolute(rel)).toBe(true);
    expect(rel).toBe(path.resolve('some/new/project'));
  });
});

// ---------------------------------------------------------------------------
// projectHash / normalizePath
// ---------------------------------------------------------------------------
describe('projectHash', () => {
  it('is sha256(realpath).slice(0,16) — 16 lowercase hex chars', async () => {
    const root = await mkProject();
    const expected = createHash('sha256')
      .update(fs.realpathSync.native(root))
      .digest('hex')
      .slice(0, 16);
    expect(projectHash(root)).toBe(expected);
    expect(projectHash(root)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is based on the real path — symlinked projectRoot yields the same hash', async () => {
    const root = await mkProject();
    const link = path.join(mkTmp(), 'proj-link');
    fs.symlinkSync(root, link);
    expect(projectHash(link)).toBe(projectHash(root));
  });

  it('differs for different projectRoots', async () => {
    const a = await mkProject();
    const b = await mkProject();
    expect(projectHash(a)).not.toBe(projectHash(b));
  });

  it('falls back to path.resolve for a non-existent path', () => {
    const p = path.join(os.tmpdir(), 'does-not-exist-xyz');
    const expected = createHash('sha256').update(path.resolve(p)).digest('hex').slice(0, 16);
    expect(projectHash(p)).toBe(expected);
  });
});

describe('normalizePath', () => {
  it('resolves and realpaths an existing path', async () => {
    const root = await mkProject();
    const link = path.join(mkTmp(), 'n-link');
    fs.symlinkSync(root, link);
    expect(normalizePath(link)).toBe(IS_WIN ? root.toLowerCase() : root);
  });

  it('still resolves a non-existent path to an absolute path', () => {
    const rel = 'x/y/z-nope';
    expect(normalizePath(rel)).toBe(
      IS_WIN ? path.resolve(rel).toLowerCase() : path.resolve(rel),
    );
  });
});

// ---------------------------------------------------------------------------
// mnemothecaPaths / vaultPaths
// ---------------------------------------------------------------------------
describe('mnemothecaPaths', () => {
  it('derives every .mnemotheca/ path under <projectRoot> (no <hash> level)', () => {
    const root = path.resolve('/tmp/proj-x');
    const p = mnemothecaPaths(root);
    expect(p.root).toBe(root);
    expect(p.dir).toBe(path.join(root, '.mnemotheca'));
    expect(p.configJson).toBe(path.join(root, '.mnemotheca', 'config.json'));
    expect(p.indexDir).toBe(path.join(root, '.mnemotheca', 'index'));
    expect(p.searchIndexJson).toBe(path.join(root, '.mnemotheca', 'index', 'search-index.json'));
    expect(p.metaJson).toBe(path.join(root, '.mnemotheca', 'index', 'meta.json'));
    expect(p.conflictsJson).toBe(path.join(root, '.mnemotheca', 'index', 'conflicts.json'));
    expect(p.parseErrorsJson).toBe(path.join(root, '.mnemotheca', 'index', 'parse-errors.json'));
    expect(p.usageLogJsonl).toBe(path.join(root, '.mnemotheca', 'index', 'usage_log.jsonl'));
    expect(p.organizeSessionJson).toBe(
      path.join(root, '.mnemotheca', 'index', 'organize-session.json'),
    );
    expect(p.snapshotsDir).toBe(path.join(root, '.mnemotheca', 'snapshots'));
  });
});

describe('vaultPaths', () => {
  it('always points under <projectRoot>/vault', () => {
    const root = path.resolve('/tmp/proj-y');
    const v = vaultPaths(root);
    expect(v.root).toBe(path.join(root, 'vault'));
    expect(v.knowledgeDir).toBe(path.join(root, 'vault', 'knowledge'));
    expect(v.categoriesDir).toBe(path.join(root, 'vault', 'categories'));
    expect(v.uncategorizedDir).toBe(path.join(root, 'vault', 'knowledge', '_uncategorized'));
    expect(v.markerJson).toBe(path.join(root, 'vault', '.mnemotheca-vault.json'));
  });
});

// ---------------------------------------------------------------------------
// runtimeBase
// ---------------------------------------------------------------------------
describe('runtimeBase', () => {
  it('prefers MNEMO_RUNTIME_DIR when it is usable', () => {
    const dir = mkTmp('mnemo-rt-');
    process.env.MNEMO_RUNTIME_DIR = dir;
    expect(runtimeBase()).toBe(path.resolve(dir));
  });

  it('falls back to os.tmpdir() when nothing else is set', () => {
    expect(runtimeBase()).toBe(path.resolve(os.tmpdir()));
  });

  it('ignores XDG_RUNTIME_DIR on non-Linux platforms', () => {
    const xdg = mkTmp('mnemo-xdg-');
    process.env.XDG_RUNTIME_DIR = xdg;
    withPlatform('darwin', () => {
      expect(runtimeBase()).toBe(path.resolve(os.tmpdir()));
    });
  });

  it('uses XDG_RUNTIME_DIR on Linux when usable', () => {
    const xdg = mkTmp('mnemo-xdg-');
    process.env.XDG_RUNTIME_DIR = xdg;
    withPlatform('linux', () => {
      expect(runtimeBase()).toBe(path.resolve(xdg));
    });
  });

  it('falls through a broken XDG_RUNTIME_DIR (not owned by us) to os.tmpdir() on Linux', () => {
    const xdg = mkTmp('mnemo-xdg-');
    process.env.XDG_RUNTIME_DIR = xdg;
    const realStat = fs.statSync.bind(fs);
    vi.spyOn(fs, 'statSync').mockImplementation(((p: fs.PathLike) => {
      const st = realStat(p);
      if (String(p) === xdg) {
        // 他ユーザー所有を偽装
        Object.defineProperty(st, 'uid', { value: (st.uid ?? 0) + 99999, configurable: true });
      }
      return st;
    }) as typeof fs.statSync);
    withPlatform('linux', () => {
      if (HAS_UID) {
        expect(runtimeBase()).toBe(path.resolve(os.tmpdir()));
      } else {
        expect(runtimeBase()).toBe(path.resolve(xdg));
      }
    });
  });

  it('falls through a non-writable XDG_RUNTIME_DIR (EACCES) to os.tmpdir() on Linux', () => {
    const xdg = mkTmp('mnemo-xdg-');
    process.env.XDG_RUNTIME_DIR = xdg;
    const realAccess = fs.accessSync.bind(fs);
    vi.spyOn(fs, 'accessSync').mockImplementation(((p: fs.PathLike, mode?: number) => {
      if (String(p) === xdg) {
        const err = new Error('EACCES') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      return realAccess(p, mode);
    }) as typeof fs.accessSync);
    withPlatform('linux', () => {
      expect(runtimeBase()).toBe(path.resolve(os.tmpdir()));
    });
  });

  it('throws RUNTIME_DIR_UNWRITABLE immediately when an explicit MNEMO_RUNTIME_DIR is unusable', () => {
    const bad = path.join(os.tmpdir(), 'mnemo-rt-missing-xyz');
    process.env.MNEMO_RUNTIME_DIR = bad;
    try {
      runtimeBase();
      expect.unreachable();
    } catch (e) {
      expect(isMnemoError(e) && e.code).toBe('RUNTIME_DIR_UNWRITABLE');
      expect(isMnemoError(e) && e.details?.['base']).toBe(bad);
    }
  });

  it('throws RUNTIME_DIR_UNWRITABLE for an explicit non-writable MNEMO_RUNTIME_DIR without falling through', () => {
    if (IS_WIN || (HAS_UID && process.getuid?.() === 0)) return; // root は書き込み制限を無視
    const dir = mkTmp('mnemo-rt-ro-');
    fs.chmodSync(dir, 0o500);
    process.env.MNEMO_RUNTIME_DIR = dir;
    try {
      runtimeBase();
      expect.unreachable();
    } catch (e) {
      expect(isMnemoError(e) && e.code).toBe('RUNTIME_DIR_UNWRITABLE');
    }
  });

  it('throws RUNTIME_DIR_UNWRITABLE when even os.tmpdir() is unusable', () => {
    vi.spyOn(fs, 'accessSync').mockImplementation((() => {
      const err = new Error('EACCES') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    }) as typeof fs.accessSync);
    try {
      runtimeBase();
      expect.unreachable();
    } catch (e) {
      expect(isMnemoError(e) && e.code).toBe('RUNTIME_DIR_UNWRITABLE');
    }
  });
});

// ---------------------------------------------------------------------------
// runtimePaths
// ---------------------------------------------------------------------------
describe('runtimePaths', () => {
  it('is <runtimeBase>/mnemotheca/<projectHash>/ with run.json and locks/', async () => {
    const root = await mkProject();
    const rtDir = mkTmp('mnemo-rt-');
    process.env.MNEMO_RUNTIME_DIR = rtDir;
    const p = runtimePaths(root);
    const hash = projectHash(root);
    expect(p.base).toBe(path.resolve(rtDir));
    expect(p.dir).toBe(path.join(path.resolve(rtDir), 'mnemotheca', hash));
    expect(p.runJson).toBe(path.join(p.dir, 'run.json'));
    expect(p.locksDir).toBe(path.join(p.dir, 'locks'));
  });
});

// ---------------------------------------------------------------------------
// ensureRuntimeDir
// ---------------------------------------------------------------------------
describe('ensureRuntimeDir', () => {
  it('creates the <projectHash> dir with mode 0o700 and returns it', async () => {
    const root = await mkProject();
    const rtDir = mkTmp('mnemo-rt-');
    process.env.MNEMO_RUNTIME_DIR = rtDir;

    const dir = await ensureRuntimeDir(root);
    expect(dir).toBe(runtimePaths(root).dir);
    expect(fs.existsSync(dir)).toBe(true);
    if (!IS_WIN) {
      expect((fs.statSync(dir).mode & 0o777).toString(8)).toBe('700');
    }
  });

  it('corrects an existing 0o755 dir to 0o700', async () => {
    if (IS_WIN) return;
    const root = await mkProject();
    const rtDir = mkTmp('mnemo-rt-');
    process.env.MNEMO_RUNTIME_DIR = rtDir;

    const target = runtimePaths(root).dir;
    fs.mkdirSync(target, { recursive: true });
    fs.chmodSync(target, 0o755);
    expect((fs.statSync(target).mode & 0o777).toString(8)).toBe('755');

    await ensureRuntimeDir(root);
    expect((fs.statSync(target).mode & 0o777).toString(8)).toBe('700');
  });

  it('is idempotent', async () => {
    const root = await mkProject();
    const rtDir = mkTmp('mnemo-rt-');
    process.env.MNEMO_RUNTIME_DIR = rtDir;
    const a = await ensureRuntimeDir(root);
    const b = await ensureRuntimeDir(root);
    expect(a).toBe(b);
    if (!IS_WIN) expect((fs.statSync(a).mode & 0o777).toString(8)).toBe('700');
  });

  it('throws RUNTIME_DIR_UNWRITABLE when no runtime base is usable', async () => {
    const root = await mkProject();
    vi.spyOn(fs, 'accessSync').mockImplementation((() => {
      const err = new Error('EACCES') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    }) as typeof fs.accessSync);
    await expect(ensureRuntimeDir(root)).rejects.toMatchObject({ code: 'RUNTIME_DIR_UNWRITABLE' });
  });

  it('throws RUNTIME_DIR_UNWRITABLE when mkdir fails (EACCES)', async () => {
    const root = await mkProject();
    const rtDir = mkTmp('mnemo-rt-');
    process.env.MNEMO_RUNTIME_DIR = rtDir;
    vi.spyOn(fs.promises, 'mkdir').mockRejectedValue(
      Object.assign(new Error('EACCES'), { code: 'EACCES' }),
    );
    await expect(ensureRuntimeDir(root)).rejects.toMatchObject({ code: 'RUNTIME_DIR_UNWRITABLE' });
  });
});
