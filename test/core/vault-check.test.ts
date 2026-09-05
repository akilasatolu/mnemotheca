// test/core/vault-check.test.ts — 設計 §13-4b / §12-2。
//
// checkVault の 4 分岐 + 正常系、write probe の場所(`.mnemotheca/index/.write-test-<rand>`)と
// try/finally での確実な削除・残骸ゼロ、isNetworkFs の名前判定・コマンド出力スタブ・判定不能→false。

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkVault, isNetworkFs, type IsNetworkFsDeps } from '../../src/core/vault-check.js';
import { makeProject } from '../helpers/project.js';

const roots: string[] = [];

async function mkProject(): Promise<string> {
  const root = await makeProject();
  roots.push(root);
  return root;
}

function indexDir(root: string): string {
  return path.join(root, '.mnemotheca', 'index');
}
function vaultDir(root: string): string {
  return path.join(root, 'vault');
}
function markerPath(root: string): string {
  return path.join(root, 'vault', '.mnemotheca-vault.json');
}

/** `.mnemotheca/index/` に write probe の残骸が無いこと。 */
function noProbeResidue(root: string): void {
  const dir = indexDir(root);
  const stray = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((n) => n.startsWith('.write-test-'))
    : [];
  expect(stray).toEqual([]);
}

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length > 0) {
    const d = roots.pop();
    if (d) {
      // 読み取り専用テストで chmod したディレクトリを消せるよう戻す。
      try {
        fs.chmodSync(path.join(d, 'vault'), 0o700);
      } catch {
        /* noop */
      }
      fs.rmSync(d, { recursive: true, force: true });
    }
  }
});

// ---------------------------------------------------------------------------
// checkVault — 4 分岐 + 正常系
// ---------------------------------------------------------------------------
describe('checkVault', () => {
  it('normal vault → { ok: true }（reason 無し）', async () => {
    const root = await mkProject();
    const res = await checkVault(root);
    expect(res).toEqual({ ok: true });
    noProbeResidue(root);
  });

  it('vault/ をまるごと削除 → { ok: false, reason: "vault-missing" }', async () => {
    const root = await mkProject();
    fs.rmSync(vaultDir(root), { recursive: true, force: true });
    expect(await checkVault(root)).toEqual({ ok: false, reason: 'vault-missing' });
  });

  it('vault/ をファイルに置換 → { ok: false, reason: "vault-not-dir" }', async () => {
    const root = await mkProject();
    fs.rmSync(vaultDir(root), { recursive: true, force: true });
    fs.writeFileSync(vaultDir(root), 'not a dir');
    expect(await checkVault(root)).toEqual({ ok: false, reason: 'vault-not-dir' });
  });

  it('vault/ が access(W_OK) 不可（EACCES をモック）→ { ok: false, reason: "vault-not-writable" }', async () => {
    const root = await mkProject();
    const realAccess = fs.promises.access.bind(fs.promises);
    vi.spyOn(fs.promises, 'access').mockImplementation((async (p: fs.PathLike, mode?: number) => {
      if (path.resolve(String(p)) === path.resolve(vaultDir(root))) {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      }
      return realAccess(p, mode);
    }) as typeof fs.promises.access);

    expect(await checkVault(root)).toEqual({ ok: false, reason: 'vault-not-writable' });
    noProbeResidue(root);
  });

  it('write probe が書けない（writeFile が EROFS）→ { ok: false, reason: "vault-not-writable" }', async () => {
    const root = await mkProject();
    vi.spyOn(fs.promises, 'writeFile').mockRejectedValue(
      Object.assign(new Error('EROFS'), { code: 'EROFS' }),
    );
    expect(await checkVault(root)).toEqual({ ok: false, reason: 'vault-not-writable' });
    noProbeResidue(root);
  });

  it('vault/.mnemotheca-vault.json だけ削除 → ok:true 維持 + reason:"marker-missing"', async () => {
    const root = await mkProject();
    fs.rmSync(markerPath(root));
    expect(await checkVault(root)).toEqual({ ok: true, reason: 'marker-missing' });
    noProbeResidue(root);
  });

  it('マーカーJSONが破損していても readVaultMarker 経由で marker-missing 扱い（ok:true 維持）', async () => {
    const root = await mkProject();
    fs.writeFileSync(markerPath(root), '{ broken json');
    expect(await checkVault(root)).toEqual({ ok: true, reason: 'marker-missing' });
  });
});

// ---------------------------------------------------------------------------
// checkVault — write probe の場所と後始末
// ---------------------------------------------------------------------------
describe('checkVault write probe', () => {
  it('probe は <projectRoot>/.mnemotheca/index/.write-test-<rand> に作られる（vault/ 直下ではない）', async () => {
    const root = await mkProject();
    const seen: string[] = [];
    const realWrite = fs.promises.writeFile.bind(fs.promises);
    vi.spyOn(fs.promises, 'writeFile').mockImplementation((async (p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      seen.push(String(p));
      return (realWrite as (...a: unknown[]) => Promise<void>)(p, ...rest);
    }) as typeof fs.promises.writeFile);

    await checkVault(root);

    const probeWrites = seen.filter((p) => path.basename(p).startsWith('.write-test-'));
    expect(probeWrites).toHaveLength(1);
    expect(path.dirname(probeWrites[0]!)).toBe(indexDir(root));
    // vault/ 直下ではないこと。
    expect(probeWrites[0]!.startsWith(vaultDir(root) + path.sep)).toBe(false);
    noProbeResidue(root);
  });

  it('probe 先ディレクトリ（.mnemotheca/index）が無ければ mkdir -p して成功する', async () => {
    const root = await mkProject();
    fs.rmSync(indexDir(root), { recursive: true, force: true });
    expect(fs.existsSync(indexDir(root))).toBe(false);

    const res = await checkVault(root);

    expect(res).toEqual({ ok: true });
    expect(fs.statSync(indexDir(root)).isDirectory()).toBe(true);
    noProbeResidue(root);
  });

  it('probe 書き込み後に本体が throw しても finally で probe を削除する（残骸ゼロ）', async () => {
    const root = await mkProject();
    let probePath: string | null = null;
    const realWrite = fs.promises.writeFile.bind(fs.promises);

    // probe ファイルは実際に作成したうえで throw させ、finally の rm を検証する。
    vi.spyOn(fs.promises, 'writeFile').mockImplementation((async (p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (path.basename(String(p)).startsWith('.write-test-')) {
        probePath = String(p);
        await (realWrite as (...a: unknown[]) => Promise<void>)(p, ...rest);
        throw Object.assign(new Error('boom after probe write'), { code: 'EIO' });
      }
      return (realWrite as (...a: unknown[]) => Promise<void>)(p, ...rest);
    }) as typeof fs.promises.writeFile);

    // 本体の inner catch が EIO を拾って vault-not-writable を返すが、finally は必ず走る。
    const res = await checkVault(root);
    expect(res).toEqual({ ok: false, reason: 'vault-not-writable' });

    expect(probePath).not.toBeNull();
    expect(fs.existsSync(probePath!)).toBe(false);
    noProbeResidue(root);
  });
});

// ---------------------------------------------------------------------------
// isNetworkFs
// ---------------------------------------------------------------------------
describe('isNetworkFs — ディレクトリ名判定', () => {
  it.each(['Dropbox', 'iCloud', 'OneDrive', 'Google Drive', 'pCloud'])(
    'パスに %s を含む → true（コマンドを叩かない）',
    (name) => {
      const runCommand = vi.fn<(cmd: string) => string | null>();
      const deps: IsNetworkFsDeps = { platform: 'darwin', runCommand };
      expect(isNetworkFs(`/Users/x/${name}/mnemo/vault`, deps)).toBe(true);
      expect(runCommand).not.toHaveBeenCalled();
    },
  );

  it('クラウド名を含まないローカルパス → コマンド判定にフォールバック', () => {
    const deps: IsNetworkFsDeps = { platform: 'darwin', runCommand: () => null };
    expect(isNetworkFs('/Users/x/projects/mnemo/vault', deps)).toBe(false);
  });
});

describe('isNetworkFs — コマンド出力スタブ', () => {
  it('Linux: df -T の type が nfs → true', () => {
    const out = [
      'Filesystem     Type 1K-blocks    Used Available Use% Mounted on',
      'srv:/export/home nfs  1000000  500000    500000  50% /home/x',
      '',
    ].join('\n');
    const deps: IsNetworkFsDeps = { platform: 'linux', runCommand: () => out };
    expect(isNetworkFs('/home/x/vault', deps)).toBe(true);
  });

  it('Linux: df -T の type が ext4 → false', () => {
    const out = [
      'Filesystem     Type 1K-blocks    Used Available Use% Mounted on',
      '/dev/sda1      ext4  1000000  500000    500000  50% /',
    ].join('\n');
    const deps: IsNetworkFsDeps = { platform: 'linux', runCommand: () => out };
    expect(isNetworkFs('/home/x/vault', deps)).toBe(false);
  });

  it('macOS: mount の type が smbfs → true（最長マウントポイント一致）', () => {
    const out = [
      '/dev/disk1s1 on / (apfs, local, journaled)',
      '//x@server/share on /Users/x/mnt (smbfs, nodev, nosuid, mounted by x)',
    ].join('\n');
    const deps: IsNetworkFsDeps = { platform: 'darwin', runCommand: () => out };
    expect(isNetworkFs('/Users/x/mnt/vault', deps)).toBe(true);
  });

  it('macOS: mount の type が apfs → false', () => {
    const out = ['/dev/disk1s1 on / (apfs, local, journaled)'].join('\n');
    const deps: IsNetworkFsDeps = { platform: 'darwin', runCommand: () => out };
    expect(isNetworkFs('/Users/x/projects/vault', deps)).toBe(false);
  });

  it.each(['afpfs', 'cifs'])('type が %s → true', (t) => {
    const out = [`srv:/e ${t}  1 1 1 1% /mnt/x`].join('\n');
    const deps: IsNetworkFsDeps = { platform: 'linux', runCommand: () => `Filesystem Type\n${out}` };
    expect(isNetworkFs('/mnt/x/vault', deps)).toBe(true);
  });
});

describe('isNetworkFs — 判定不能は false', () => {
  it('コマンドが実行不能（runCommand が null）→ false', () => {
    const deps: IsNetworkFsDeps = { platform: 'linux', runCommand: () => null };
    expect(isNetworkFs('/home/x/vault', deps)).toBe(false);
  });

  it('出力がパース不能 → false', () => {
    const deps: IsNetworkFsDeps = { platform: 'darwin', runCommand: () => 'garbage output ??? no parens' };
    expect(isNetworkFs('/Users/x/vault', deps)).toBe(false);
  });

  it('その他プラットフォーム（win32）→ コマンドを叩かず false', () => {
    const runCommand = vi.fn<(cmd: string) => string | null>();
    expect(isNetworkFs('C:/Users/x/vault', { platform: 'win32', runCommand })).toBe(false);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('df の Mounted-on 側にネットワーク名があっても type 列だけで判定する（誤検出しない）', () => {
    const out = 'Filesystem Type\n/dev/sda1 ext4 1 1 1 1% /mnt/nfs-backup';
    const deps: IsNetworkFsDeps = { platform: 'linux', runCommand: () => out };
    expect(isNetworkFs('/mnt/nfs-backup/vault', deps)).toBe(false);
  });
});
