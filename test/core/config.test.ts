import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadConfig,
  readVaultMarker,
  saveConfig,
  writeVaultMarker,
  type Config,
} from '../../src/core/config.js';
import { isMnemoError } from '../../src/core/errors.js';
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
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

function configPath(root: string): string {
  return path.join(root, '.mnemotheca', 'config.json');
}
function markerPath(root: string): string {
  return path.join(root, 'vault', '.mnemotheca-vault.json');
}
function mnemoDir(root: string): string {
  return path.join(root, '.mnemotheca');
}

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------
describe('loadConfig', () => {
  it('reads a well-formed config.json', async () => {
    const root = await mkProject();
    const cfg = await loadConfig(root);
    expect(cfg.v).toBe(1);
    expect(typeof cfg.createdAt).toBe('string');
    expect(typeof cfg.updatedAt).toBe('string');
  });

  it('throws NOT_INITIALIZED when config.json is missing', async () => {
    const root = await mkProject();
    fs.rmSync(configPath(root));
    await expect(loadConfig(root)).rejects.toSatisfy(
      (e: unknown) => isMnemoError(e) && e.code === 'NOT_INITIALIZED',
    );
  });

  it('is read-only on the happy path: file bytes and mtime are unchanged', async () => {
    const root = await mkProject();
    const before = fs.readFileSync(configPath(root));
    const mtimeBefore = fs.statSync(configPath(root)).mtimeMs;
    await new Promise((r) => setTimeout(r, 15));

    await loadConfig(root);

    const after = fs.readFileSync(configPath(root));
    expect(after.equals(before)).toBe(true);
    expect(fs.statSync(configPath(root)).mtimeMs).toBe(mtimeBefore);
  });

  it('on corrupt JSON: throws CONFIG_CORRUPT, moves the file to config.json.bak-<ts>, writes no new config.json', async () => {
    const root = await mkProject();
    fs.writeFileSync(configPath(root), '{ this is not : json ');

    const err = await loadConfig(root).catch((e: unknown) => e);
    expect(isMnemoError(err) && err.code === 'CONFIG_CORRUPT').toBe(true);

    // 元ファイルは退避で消えている(loadConfig は新規に書かない)。
    expect(fs.existsSync(configPath(root))).toBe(false);

    const baks = fs
      .readdirSync(mnemoDir(root))
      .filter((n) => n.startsWith('config.json.bak-'));
    expect(baks).toHaveLength(1);
    // 退避ファイルの中身は壊れた元データそのもの。
    expect(fs.readFileSync(path.join(mnemoDir(root), baks[0]!), 'utf8')).toBe(
      '{ this is not : json ',
    );
  });

  it('treats a non-object JSON payload (e.g. an array) as CONFIG_CORRUPT', async () => {
    const root = await mkProject();
    fs.writeFileSync(configPath(root), '[1,2,3]\n');
    const err = await loadConfig(root).catch((e: unknown) => e);
    expect(isMnemoError(err) && err.code === 'CONFIG_CORRUPT').toBe(true);
    expect(fs.existsSync(configPath(root))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// saveConfig
// ---------------------------------------------------------------------------
describe('saveConfig', () => {
  it('no-op branch: when nothing effectively changes, the file bytes and updatedAt are untouched', async () => {
    const root = await mkProject();
    const before = fs.readFileSync(configPath(root));
    const original = await loadConfig(root);
    const mtimeBefore = fs.statSync(configPath(root)).mtimeMs;
    await new Promise((r) => setTimeout(r, 15));

    // 現在値と実質同じ(v は既に 1、updatedAt は判定対象外)。
    const returned = await saveConfig(root, { v: 1, updatedAt: 'IGNORED' } as Partial<Config>);

    const after = fs.readFileSync(configPath(root));
    expect(after.equals(before)).toBe(true); // バイト列不変
    expect(fs.statSync(configPath(root)).mtimeMs).toBe(mtimeBefore);
    expect(returned.updatedAt).toBe(original.updatedAt); // updatedAt 不変
    expect(returned.createdAt).toBe(original.createdAt);
  });

  it('real-change branch: merges the field, bumps updatedAt, keeps createdAt, and writes atomically', async () => {
    const root = await mkProject();
    const original = await loadConfig(root);
    await new Promise((r) => setTimeout(r, 5));

    // 将来の設定項目に相当する新フィールドを 1 つ足す = 実変更あり。
    const returned = await saveConfig(
      root,
      { theme: 'dark' } as unknown as Partial<Config>,
    );

    expect(returned.createdAt).toBe(original.createdAt); // createdAt 保持
    expect(returned.updatedAt).not.toBe(original.updatedAt); // updatedAt 更新
    expect(Date.parse(returned.updatedAt)).toBeGreaterThanOrEqual(
      Date.parse(original.updatedAt),
    );

    // ディスクに反映され、正しい JSON になっている。
    const onDisk = JSON.parse(fs.readFileSync(configPath(root), 'utf8'));
    expect(onDisk).toEqual({ ...returned });
    expect(onDisk.theme).toBe('dark');
    expect(onDisk.v).toBe(1);

    // atomic write の一時ファイルが残っていない。
    const leftovers = fs
      .readdirSync(mnemoDir(root))
      .filter((n) => n.includes('.tmp-'));
    expect(leftovers).toHaveLength(0);

    // 2 回目の同一呼び出しは no-op(冪等)。
    const second = await saveConfig(root, { theme: 'dark' } as unknown as Partial<Config>);
    expect(second.updatedAt).toBe(returned.updatedAt);
  });

  it('throws NOT_INITIALIZED when there is no config.json to merge into', async () => {
    const root = await mkProject();
    fs.rmSync(configPath(root));
    await expect(
      saveConfig(root, { v: 1 } as Partial<Config>),
    ).rejects.toSatisfy((e: unknown) => isMnemoError(e) && e.code === 'NOT_INITIALIZED');
  });
});

// ---------------------------------------------------------------------------
// readVaultMarker / writeVaultMarker
// ---------------------------------------------------------------------------
describe('readVaultMarker', () => {
  it('returns the marker when present', async () => {
    const root = await mkProject();
    const m = await readVaultMarker(root);
    expect(m).not.toBeNull();
    expect(m!.v).toBe(1);
    expect(typeof m!.createdAt).toBe('string');
  });

  it('returns null when the marker file is absent', async () => {
    const root = await mkProject();
    fs.rmSync(markerPath(root));
    expect(await readVaultMarker(root)).toBeNull();
  });

  it('returns null when the marker file is corrupt JSON', async () => {
    const root = await mkProject();
    fs.writeFileSync(markerPath(root), 'not json');
    expect(await readVaultMarker(root)).toBeNull();
  });
});

describe('writeVaultMarker', () => {
  it('creates the marker on first call', async () => {
    const root = await mkProject();
    fs.rmSync(markerPath(root));

    await writeVaultMarker(root);

    expect(fs.existsSync(markerPath(root))).toBe(true);
    const m = await readVaultMarker(root);
    expect(m!.v).toBe(1);
    expect(typeof m!.createdAt).toBe('string');
  });

  it('is idempotent: a second call keeps createdAt and the file bytes unchanged', async () => {
    const root = await mkProject();
    fs.rmSync(markerPath(root));

    await writeVaultMarker(root);
    const first = await readVaultMarker(root);
    const bytesAfterFirst = fs.readFileSync(markerPath(root));
    await new Promise((r) => setTimeout(r, 15));

    await writeVaultMarker(root);
    const second = await readVaultMarker(root);
    const bytesAfterSecond = fs.readFileSync(markerPath(root));

    expect(second!.createdAt).toBe(first!.createdAt); // createdAt 不変
    expect(bytesAfterSecond.equals(bytesAfterFirst)).toBe(true);
  });

  it('does nothing when a marker already exists (from makeProject)', async () => {
    const root = await mkProject();
    const before = fs.readFileSync(markerPath(root));
    await writeVaultMarker(root);
    expect(fs.readFileSync(markerPath(root)).equals(before)).toBe(true);
  });
});
