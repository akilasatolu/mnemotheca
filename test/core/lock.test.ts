import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isMnemoError } from '../../src/core/errors.js';
import { lockfileTarget, scopeToFilename, withLock } from '../../src/core/lock.js';
import { projectHash, runtimePaths } from '../../src/core/paths.js';
import { makeProject } from '../helpers/project.js';

const require = createRequire(import.meta.url);
const PROPER_LOCKFILE_MAIN = require.resolve('proper-lockfile');

const roots: string[] = [];
const childScripts: string[] = [];

async function mkProject(): Promise<string> {
  const root = fs.realpathSync.native(await makeProject());
  roots.push(root);
  return root;
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function listLockFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.name.endsWith('.lock')) out.push(p);
      if (ent.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out;
}

let savedRuntimeDir: string | undefined;

beforeEach(() => {
  savedRuntimeDir = process.env.MNEMO_RUNTIME_DIR;
});

afterEach(() => {
  if (savedRuntimeDir === undefined) delete process.env.MNEMO_RUNTIME_DIR;
  else process.env.MNEMO_RUNTIME_DIR = savedRuntimeDir;

  while (roots.length > 0) {
    const root = roots.pop();
    if (!root) continue;
    fs.rmSync(root, { recursive: true, force: true });
    // 既定ではランタイムベース = os.tmpdir()。projectHash 単位のスロットも掃除する。
    fs.rmSync(path.join(os.tmpdir(), 'mnemotheca', projectHash(root)), {
      recursive: true,
      force: true,
    });
  }
  while (childScripts.length > 0) {
    const s = childScripts.pop();
    if (s) fs.rmSync(s, { recursive: true, force: true });
  }
});

describe('scopeToFilename()', () => {
  it('passes plain scopes through and escapes ":" / "/"', () => {
    expect(scopeToFilename('vault')).toBe('vault');
    expect(scopeToFilename('index')).toBe('index');
    expect(scopeToFilename('category:work')).toBe('category__work');
    expect(scopeToFilename('category:a/b')).toBe('category__a__b');
  });
});

describe('withLock() — serialization', () => {
  it('serializes sequential withLock calls on the same scope (no overlap)', async () => {
    const root = await mkProject();
    const events: string[] = [];
    const body = (tag: string) => async (): Promise<void> => {
      events.push(`${tag}:start`);
      await delay(60);
      events.push(`${tag}:end`);
    };

    await Promise.all([
      withLock(root, 'knowledge', body('A')),
      withLock(root, 'knowledge', body('B')),
    ]);

    const first = events[0]?.[0];
    expect(events).toEqual(
      first === 'A'
        ? ['A:start', 'A:end', 'B:start', 'B:end']
        : ['B:start', 'B:end', 'A:start', 'A:end'],
    );
  });

  it('does not let a different projectRoot with the same scope interfere', async () => {
    const rootA = await mkProject();
    const rootB = await mkProject();

    let openGate: () => void = () => {};
    const gate = new Promise<void>((r) => {
      openGate = r;
    });
    const held = withLock(rootA, 'vault', () => gate);
    await delay(50); // rootA がロックを保持している状態にする

    const t0 = Date.now();
    await withLock(rootB, 'vault', async () => {
      /* すぐ取れるはず */
    });
    expect(Date.now() - t0).toBeLessThan(1000);

    openGate();
    await held;
  });
});

describe('withLock() — contention across processes', () => {
  it('throws LOCK_TIMEOUT while another process holds the lock', async () => {
    const root = await mkProject();
    const target = await lockfileTarget(root, 'knowledge');

    const script = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'mnemo-lock-child-')),
      'hold.cjs',
    );
    childScripts.push(path.dirname(script));
    fs.writeFileSync(
      script,
      `const fs = require('fs');
const lockfile = require(${JSON.stringify(PROPER_LOCKFILE_MAIN)});
const [, , target, holdMs] = process.argv;
lockfile
  .lock(target, { realpath: false, stale: 20000, retries: 0 })
  .then(async (release) => {
    fs.writeFileSync(target + '.acquired', '1');
    await new Promise((r) => setTimeout(r, Number(holdMs)));
    await release();
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
`,
    );

    const child = spawn(process.execPath, [script, target, '4000'], { stdio: 'ignore' });
    try {
      const acquiredFlag = `${target}.acquired`;
      const deadline = Date.now() + 4000;
      while (!fs.existsSync(acquiredFlag)) {
        if (Date.now() > deadline) throw new Error('child never acquired the lock');
        await delay(25);
      }

      let caught: unknown;
      try {
        await withLock(root, 'knowledge', async () => undefined, { retries: 2 });
      } catch (e) {
        caught = e;
      }
      expect(isMnemoError(caught) && caught.code).toBe('LOCK_TIMEOUT');
      expect(isMnemoError(caught) && caught.details?.['scope']).toBe('knowledge');
    } finally {
      child.kill('SIGKILL');
      await new Promise((r) => child.on('close', r));
    }
  });
});

describe('withLock() — stale takeover', () => {
  it('steals a lock whose mtime is older than staleMs', async () => {
    const root = await mkProject();
    const target = await lockfileTarget(root, 'index');
    const artifact = `${target}.lock`;

    fs.mkdirSync(artifact);
    const old = (Date.now() - 60_000) / 1000;
    fs.utimesSync(artifact, old, old);

    const result = await withLock(root, 'index', async () => 'stolen', {
      staleMs: 2000,
      retries: 2,
    });
    expect(result).toBe('stolen');
    expect(fs.existsSync(artifact)).toBe(false); // 解放済み
  });
});

describe('withLock() — lock file location', () => {
  it('creates the lock under <runtimeBase>/mnemotheca/<hash>/locks and never under projectRoot/vault', async () => {
    const root = await mkProject();
    const { locksDir } = runtimePaths(root);

    await withLock(root, 'vault', async () => {
      expect(fs.existsSync(path.join(locksDir, 'vault.lock'))).toBe(true);
      // 保持中でも projectRoot 配下には .lock が無い
      expect(listLockFiles(root)).toEqual([]);
    });

    expect(listLockFiles(root)).toEqual([]);
    expect(fs.existsSync(path.join(root, 'vault', 'vault.lock'))).toBe(false);
  });
});

describe('withLock() — runtime dir errors', () => {
  it('propagates RUNTIME_DIR_UNWRITABLE from ensureRuntimeDir', async () => {
    const root = await mkProject();
    process.env.MNEMO_RUNTIME_DIR = path.join(os.tmpdir(), 'mnemo-lock-nonexistent-xyz-123');

    let caught: unknown;
    try {
      await withLock(root, 'vault', async () => undefined);
    } catch (e) {
      caught = e;
    }
    expect(isMnemoError(caught) && caught.code).toBe('RUNTIME_DIR_UNWRITABLE');
  });
});
