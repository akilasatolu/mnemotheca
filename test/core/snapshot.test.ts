import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isMnemoError } from '../../src/core/errors.js';
import { mnemothecaPaths, projectHash, vaultPaths } from '../../src/core/paths.js';
import {
  createSnapshot,
  finalizeSnapshotManifest,
  gcSnapshots,
  listSnapshots,
  restoreSnapshot,
  type SnapshotManifest,
} from '../../src/core/snapshot.js';
import { makeProject } from '../helpers/project.js';

const roots: string[] = [];

async function mkProject(): Promise<string> {
  const root = fs.realpathSync.native(await makeProject());
  roots.push(root);
  return root;
}

function writeVaultFile(root: string, relPath: string, content: string): void {
  const abs = path.join(vaultPaths(root).root, ...relPath.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

function readVaultFile(root: string, relPath: string): string {
  return fs.readFileSync(path.join(vaultPaths(root).root, ...relPath.split('/')), 'utf8');
}

function vaultExists(root: string, relPath: string): boolean {
  return fs.existsSync(path.join(vaultPaths(root).root, ...relPath.split('/')));
}

function readManifest(root: string, snapId: string): SnapshotManifest {
  const p = path.join(mnemothecaPaths(root).snapshotsDir, snapId, 'manifest.json');
  return JSON.parse(fs.readFileSync(p, 'utf8')) as SnapshotManifest;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length > 0) {
    const root = roots.pop();
    if (!root) continue;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(path.join(os.tmpdir(), 'mnemotheca', projectHash(root)), {
      recursive: true,
      force: true,
    });
  }
});

describe('createSnapshot()', () => {
  it('copies only affected files, reproduces vault-relative layout, writes manifest', async () => {
    const root = await mkProject();
    writeVaultFile(root, 'knowledge/tech/a.md', 'AAA');
    writeVaultFile(root, 'knowledge/tech/deep/b.md', 'BBB');
    writeVaultFile(root, 'knowledge/other/c.md', 'CCC'); // 影響外

    const snapId = await createSnapshot(root, 'organize', [
      'knowledge/tech/a.md',
      'knowledge/tech/deep/b.md',
      'knowledge/tech/will-be-created.md', // まだ存在しない → スキップ
    ]);

    const snapDir = path.join(mnemothecaPaths(root).snapshotsDir, snapId);
    expect(fs.readFileSync(path.join(snapDir, 'files/knowledge/tech/a.md'), 'utf8')).toBe('AAA');
    expect(fs.readFileSync(path.join(snapDir, 'files/knowledge/tech/deep/b.md'), 'utf8')).toBe('BBB');
    // 影響外・未存在ファイルはコピーされない
    expect(fs.existsSync(path.join(snapDir, 'files/knowledge/other/c.md'))).toBe(false);
    expect(fs.existsSync(path.join(snapDir, 'files/knowledge/tech/will-be-created.md'))).toBe(false);

    const manifest = readManifest(root, snapId);
    expect(manifest.v).toBe(1);
    expect(manifest.label).toBe('organize');
    expect(manifest.created).toEqual([]);
    expect(manifest.files).toEqual([
      { relPath: 'knowledge/tech/a.md', state: 'modified', savedAs: 'files/knowledge/tech/a.md' },
      {
        relPath: 'knowledge/tech/deep/b.md',
        state: 'modified',
        savedAs: 'files/knowledge/tech/deep/b.md',
      },
    ]);
    expect(snapId.startsWith('organize-')).toBe(true);
  });

  it('creates snapshots under <projectRoot>/.mnemotheca/snapshots/, not ~/.mnemotheca', async () => {
    const root = await mkProject();
    writeVaultFile(root, 'knowledge/a.md', 'x');

    const snapId = await createSnapshot(root, 'organize', ['knowledge/a.md']);

    const expectedDir = path.join(root, '.mnemotheca', 'snapshots', snapId);
    expect(fs.existsSync(expectedDir)).toBe(true);
    expect(mnemothecaPaths(root).snapshotsDir).toBe(path.join(root, '.mnemotheca', 'snapshots'));
    // ホーム配下には作られない
    expect(fs.existsSync(path.join(os.homedir(), '.mnemotheca', 'snapshots', snapId))).toBe(false);
  });

  it('throws SNAPSHOT_FAILED on copy failure (disk full) and leaves vault + snapshots clean', async () => {
    const root = await mkProject();
    writeVaultFile(root, 'knowledge/a.md', 'original');

    const spy = vi
      .spyOn(fs.promises, 'copyFile')
      .mockRejectedValueOnce(Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' }));

    let caught: unknown;
    try {
      await createSnapshot(root, 'organize', ['knowledge/a.md']);
    } catch (e) {
      caught = e;
    }
    expect(isMnemoError(caught) && caught.code).toBe('SNAPSHOT_FAILED');
    spy.mockRestore();

    // vault は無変更
    expect(readVaultFile(root, 'knowledge/a.md')).toBe('original');
    // 部分生成物は残らない
    expect(fs.readdirSync(mnemothecaPaths(root).snapshotsDir)).toEqual([]);
  });
});

describe('finalizeSnapshotManifest()', () => {
  it('appends created and patches deletions (modified -> deleted)', async () => {
    const root = await mkProject();
    writeVaultFile(root, 'knowledge/keep.md', 'K');
    writeVaultFile(root, 'knowledge/gone.md', 'G');

    const snapId = await createSnapshot(root, 'organize', [
      'knowledge/keep.md',
      'knowledge/gone.md',
    ]);

    await finalizeSnapshotManifest(root, snapId, {
      created: ['knowledge/new-1.md', 'knowledge/new-2.md'],
      deletions: ['knowledge/gone.md'],
    });

    const manifest = readManifest(root, snapId);
    expect(manifest.created).toEqual(['knowledge/new-1.md', 'knowledge/new-2.md']);
    const gone = manifest.files.find((f) => f.relPath === 'knowledge/gone.md');
    const keep = manifest.files.find((f) => f.relPath === 'knowledge/keep.md');
    expect(gone?.state).toBe('deleted');
    expect(keep?.state).toBe('modified');

    // 二重 finalize でも created は重複しない(冪等)
    await finalizeSnapshotManifest(root, snapId, { created: ['knowledge/new-1.md'] });
    expect(readManifest(root, snapId).created).toEqual(['knowledge/new-1.md', 'knowledge/new-2.md']);
  });
});

describe('restoreSnapshot()', () => {
  it('restores modified, revives deleted, removes created, prunes empty dirs', async () => {
    const root = await mkProject();
    writeVaultFile(root, 'knowledge/mod.md', 'v1');
    writeVaultFile(root, 'knowledge/sub/del.md', 'to-delete');

    const snapId = await createSnapshot(root, 'organize', [
      'knowledge/mod.md',
      'knowledge/sub/del.md',
    ]);

    // apply を模擬: mod.md 変更 / del.md 削除 / created.md 新規
    writeVaultFile(root, 'knowledge/mod.md', 'v2-changed');
    fs.rmSync(path.join(vaultPaths(root).root, 'knowledge/sub/del.md'));
    fs.rmdirSync(path.join(vaultPaths(root).root, 'knowledge/sub'));
    writeVaultFile(root, 'knowledge/created/created.md', 'brand new');

    await finalizeSnapshotManifest(root, snapId, {
      created: ['knowledge/created/created.md'],
      deletions: ['knowledge/sub/del.md'],
    });

    await restoreSnapshot(root, snapId);

    expect(readVaultFile(root, 'knowledge/mod.md')).toBe('v1');
    expect(readVaultFile(root, 'knowledge/sub/del.md')).toBe('to-delete');
    expect(vaultExists(root, 'knowledge/created/created.md')).toBe(false);
    // created を消した結果、空になった親ディレクトリも掃除される
    expect(fs.existsSync(path.join(vaultPaths(root).root, 'knowledge/created'))).toBe(false);
  });

  it('is idempotent: calling twice with the same snapId is safe and yields the same result', async () => {
    const root = await mkProject();
    writeVaultFile(root, 'knowledge/mod.md', 'orig');

    const snapId = await createSnapshot(root, 'organize', ['knowledge/mod.md']);
    writeVaultFile(root, 'knowledge/mod.md', 'edited');
    writeVaultFile(root, 'knowledge/created.md', 'new');
    await finalizeSnapshotManifest(root, snapId, { created: ['knowledge/created.md'] });

    await restoreSnapshot(root, snapId);
    const afterFirst = {
      mod: readVaultFile(root, 'knowledge/mod.md'),
      createdGone: !vaultExists(root, 'knowledge/created.md'),
    };

    // 2 回目: created は既に無い(unlink ENOENT を握りつぶす)、例外なし
    await expect(restoreSnapshot(root, snapId)).resolves.toBeUndefined();
    expect(readVaultFile(root, 'knowledge/mod.md')).toBe(afterFirst.mod);
    expect(!vaultExists(root, 'knowledge/created.md')).toBe(afterFirst.createdGone);
    expect(afterFirst).toEqual({ mod: 'orig', createdGone: true });
  });

  it('throws SNAPSHOT_FAILED for an unknown snapshot id', async () => {
    const root = await mkProject();
    let caught: unknown;
    try {
      await restoreSnapshot(root, 'organize-does-not-exist');
    } catch (e) {
      caught = e;
    }
    expect(isMnemoError(caught) && caught.code).toBe('SNAPSHOT_FAILED');
  });
});

describe('listSnapshots() / gcSnapshots()', () => {
  it('lists newest-first and gcSnapshots(keep=5) drops the oldest on the 6th generation', async () => {
    const root = await mkProject();
    writeVaultFile(root, 'knowledge/a.md', 'a');

    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      ids.push(await createSnapshot(root, 'organize', ['knowledge/a.md']));
    }

    const before = await listSnapshots(root);
    expect(before).toHaveLength(6);
    // createdAt 降順 = 生成順の逆
    expect(before.map((s) => s.id)).toEqual([...ids].reverse());

    await gcSnapshots(root, 5);

    const after = await listSnapshots(root);
    expect(after).toHaveLength(5);
    expect(after.map((s) => s.id)).toEqual([...ids].reverse().slice(0, 5));
    // 最古の 1 世代がディスクからも消えている
    expect(fs.existsSync(path.join(mnemothecaPaths(root).snapshotsDir, ids[0]!))).toBe(false);
  });

  it('returns [] when no snapshots directory exists yet', async () => {
    const root = await mkProject();
    await expect(listSnapshots(root)).resolves.toEqual([]);
    await expect(gcSnapshots(root, 5)).resolves.toBeUndefined();
  });

  it('reports fileCount and label from the manifest', async () => {
    const root = await mkProject();
    writeVaultFile(root, 'knowledge/a.md', 'a');
    writeVaultFile(root, 'knowledge/b.md', 'b');
    const snapId = await createSnapshot(root, 'my-label', ['knowledge/a.md', 'knowledge/b.md']);
    await finalizeSnapshotManifest(root, snapId, { created: ['knowledge/c.md'] });

    const [info] = await listSnapshots(root);
    expect(info?.label).toBe('my-label');
    expect(info?.fileCount).toBe(3); // 2 files + 1 created
  });
});
