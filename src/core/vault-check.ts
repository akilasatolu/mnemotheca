// src/core/vault-check.ts — projectRoot / vault の健全性チェック(設計書 §12-2 / §13-4b)。
//
// - `checkVault(projectRoot)`  … vault ディレクトリの存在・種別・書き込み可否・マーカーを検査。
// - `isNetworkFs(p, deps?)`    … パスがクラウド同期 / ネットワーク FS 上かを推定(watcher の
//                                usePolling 判定用。誤判定しても watcher 効率が落ちるだけ)。
//
// 依存は node:fs / node:path / node:crypto / node:os / node:child_process のみ(設計 §1-3)。
// child_process は `isNetworkFs` のコマンド実行部分のみで使い、テスト時は `deps.runCommand`
// で差し替え可能にしている(実コマンドを叩かない)。

import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readVaultMarker } from './config.js';
import { mnemothecaPaths, vaultPaths } from './paths.js';

/** `checkVault` の返り値(設計 §12-2)。 */
export interface VaultCheckResult {
  /** vault が使用可能か。`marker-missing` のときも `true`(警告レベル)。 */
  ok: boolean;
  /**
   * NG / 警告の理由。
   * - `vault-missing`      … `<projectRoot>/vault/` が存在しない(`VAULT_UNAVAILABLE`)。
   * - `vault-not-dir`      … `vault/` がディレクトリではない(ファイル等)。
   * - `vault-not-writable` … `vault/` に書き込めない(`VAULT_NOT_WRITABLE`)。
   * - `marker-missing`     … `vault/.mnemotheca-vault.json` が無い。**`ok:true` 維持**の警告。
   */
  reason?: 'vault-missing' | 'vault-not-dir' | 'vault-not-writable' | 'marker-missing';
}

/**
 * vault の健全性を検査する(設計 §12-2 / §13-4b)。
 *
 * 判定順:
 *   1. `<projectRoot>/vault/` を `stat` できない → `{ ok:false, reason:'vault-missing' }`
 *   2. ディレクトリでない                        → `{ ok:false, reason:'vault-not-dir' }`
 *   3. `vault/` が書き込み不可(`access(W_OK)` 失敗) → `{ ok:false, reason:'vault-not-writable' }`
 *   4. write probe 失敗(読み取り専用 FS 等)      → `{ ok:false, reason:'vault-not-writable' }`
 *   5. `readVaultMarker`(§8-B)が `null`     → `{ ok:true,  reason:'marker-missing' }`
 *   6. すべて OK                                   → `{ ok:true }`
 *
 * write probe は **`vault/` 直下ではなく** gitignore 済みの
 * `<projectRoot>/.mnemotheca/index/.write-test-<rand>` に作り(クラッシュ時に stray ファイルが
 * git のコミット対象に見えるのを避ける)、`try { write } finally { rm }` で成功・失敗どちらでも
 * 確実に削除する。probe 先ディレクトリが無ければ `mkdir -p` する。
 */
export async function checkVault(projectRoot: string): Promise<VaultCheckResult> {
  const v = vaultPaths(projectRoot);
  const { indexDir } = mnemothecaPaths(projectRoot);

  let st: fs.Stats;
  try {
    st = await fs.promises.stat(v.root);
  } catch {
    return { ok: false, reason: 'vault-missing' };
  }
  if (!st.isDirectory()) {
    return { ok: false, reason: 'vault-not-dir' };
  }

  try {
    await fs.promises.access(v.root, fs.constants.W_OK);
  } catch {
    return { ok: false, reason: 'vault-not-writable' };
  }

  const probe = path.join(indexDir, `.write-test-${randomBytes(8).toString('hex')}`);
  try {
    try {
      await fs.promises.mkdir(indexDir, { recursive: true });
      await fs.promises.writeFile(probe, String(process.pid), { flag: 'wx' });
    } catch {
      return { ok: false, reason: 'vault-not-writable' };
    }

    // マーカー欠落判定は `readVaultMarker` に委譲する(fs 直接判定はしない)。
    // `readVaultMarker` は「無い / 読めない / JSON 破損」をすべて `null` で返す(警告レベル)。
    if ((await readVaultMarker(projectRoot)) === null) {
      return { ok: true, reason: 'marker-missing' };
    }
    return { ok: true };
  } finally {
    await fs.promises.rm(probe, { force: true }).catch(() => {});
  }
}

/** `isNetworkFs` の注入ポイント(テストで実コマンドを叩かないため)。 */
export interface IsNetworkFsDeps {
  /** 省略時は `os.platform()`。 */
  platform?: NodeJS.Platform;
  /**
   * シェルコマンドを実行して stdout を返す。実行不能なら `null`。
   * 省略時は `child_process.execSync`(失敗時 `null`)。
   */
  runCommand?: (cmd: string) => string | null;
}

/** 既知のクラウド同期ディレクトリ名(設計 §12-2)。 */
const CLOUD_DIR_RE = /(?:Dropbox|iCloud|OneDrive|Google Drive|pCloud)/;

/** ネットワーク FS の type(設計 §12-2)。 */
const NETWORK_FS_TYPE_RE = /^(?:nfs|smbfs|cifs|afpfs)$/i;

function defaultRunCommand(cmd: string): string | null {
  try {
    return execSync(cmd, {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/** POSIX シェル向けに単一引用符でクォートする。 */
function shellQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/** `df -T <path>` の出力から FS type(2 列目)を取り出す。判定不能なら `null`。 */
function parseDfType(out: string | null): string | null {
  if (out == null) return null;
  const lines = out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  for (const line of lines) {
    if (/^Filesystem\b/i.test(line)) continue;
    const fields = line.split(/\s+/);
    if (fields.length >= 2 && fields[1]) return fields[1];
  }
  return null;
}

/**
 * `mount` の出力から、`p` を含む最長のマウントポイントの FS type を取り出す。
 * 各行は `<device> on <mountpoint> (<type>, <opts...>)` 形式。判定不能なら `null`。
 */
function parseMountType(out: string | null, p: string): string | null {
  if (out == null) return null;
  const target = path.resolve(p);
  let best: string | null = null;
  let bestLen = -1;
  for (const line of out.split('\n')) {
    const m = /^.* on (.+?) \(([^)]*)\)\s*$/.exec(line.trim());
    if (!m || !m[1] || m[2] === undefined) continue;
    const mp = m[1];
    const under = mp === '/' ? target === '/' || target.startsWith('/') : target === mp || target.startsWith(`${mp}/`);
    if (!under) continue;
    if (mp.length > bestLen) {
      bestLen = mp.length;
      best = (m[2].split(',')[0] ?? '').trim() || null;
    }
  }
  return best;
}

/**
 * `p` がクラウド同期 / ネットワーク FS 上にあると推定されるか(設計 §12-2 / §13-4b)。
 *
 * - パスに `Dropbox` / `iCloud` / `OneDrive` / `Google Drive` / `pCloud` を含む → `true`
 * - Linux: `df -T <p>` の type、macOS: `mount` の type が `nfs|smbfs|cifs|afpfs` → `true`
 * - コマンドが無い / 出力パース不能 / その他プラットフォーム → `false`(ローカル扱い)
 *
 * 判定ミスしても watcher の効率が落ちるだけで正しさは損なわれない。
 */
export function isNetworkFs(p: string, deps: IsNetworkFsDeps = {}): boolean {
  if (CLOUD_DIR_RE.test(p)) return true;

  const platform = deps.platform ?? os.platform();
  const run = deps.runCommand ?? defaultRunCommand;

  let type: string | null = null;
  if (platform === 'linux') {
    type = parseDfType(run(`df -T ${shellQuote(p)}`));
  } else if (platform === 'darwin') {
    type = parseMountType(run('mount'), p);
  } else {
    return false;
  }

  return type != null && NETWORK_FS_TYPE_RE.test(type);
}
