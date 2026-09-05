// src/core/config.ts — `.mnemotheca/config.json` と `vault/.mnemotheca-vault.json`
// (最小マーカー)の読み書き(設計書 §8-B / §9-2 / §9-3 / §4-1)。
//
// 不変条件(config.json の git churn を防ぐ・設計 §8-B):
//  - `loadConfig` は **いかなる場合もファイルに書き込まない**(読み取り専用)。
//    破損時の `.bak-<ts>` 退避は「リネーム(移動)」であり新規書き込みではない。
//  - `saveConfig` は実際に変更があるフィールドが 1 つ以上あるときだけ `updatedAt` を
//    更新して書く。変更が実質ゼロなら config.json には一切触れない(バイト列不変)。
//  - `writeVaultMarker` は初回のみ生成。既存なら何もしない(`createdAt` を保持=冪等)。
//
// 依存は node:fs / node:path のみ(設計 §1-3)。

import fs from 'node:fs';
import path from 'node:path';
import { MnemoError } from './errors.js';
import { mnemothecaPaths, vaultPaths } from './paths.js';

/** `.mnemotheca/config.json` のスキーマ(設計 §9-2)。`vaultPath` は持たない。将来の設定用の器。 */
export interface Config {
  v: 1;
  createdAt: string;
  updatedAt: string;
}

/** `vault/.mnemotheca-vault.json` のスキーマ(設計 §9-3)。「このディレクトリが vault である」印。 */
export interface VaultMarker {
  v: 1;
  createdAt: string;
}

/** JSON を 2 スペースインデント + 末尾改行で直列化する(プロジェクト内の既存 JSON 生成と統一)。 */
function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * 同一ディレクトリの一時ファイルに書いてから `rename` で原子的に置き換える
 * (tmp+rename・設計 §8-B「atomic write」)。失敗時は一時ファイルを掃除する。
 */
async function atomicWrite(filePath: string, data: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    await fs.promises.writeFile(tmp, data, { encoding: 'utf8', mode: 0o644 });
    await fs.promises.rename(tmp, filePath);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * `<projectRoot>/.mnemotheca/config.json` を読む(設計 §8-B)。
 *
 * - ファイルが無い → `MnemoError('NOT_INITIALIZED')`
 * - JSON として壊れている / オブジェクトでない → `<...>/config.json.bak-<ts>` に退避してから
 *   `MnemoError('CONFIG_CORRUPT')`。**この関数は新しい config.json を書かない**(退避のみ)。
 */
export async function loadConfig(projectRoot: string): Promise<Config> {
  const { configJson } = mnemothecaPaths(projectRoot);

  let raw: string;
  try {
    raw = await fs.promises.readFile(configJson, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new MnemoError(
        'NOT_INITIALIZED',
        `${configJson} が見つかりません。init で初期化してください`,
        { configJson },
      );
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
    if (!isRecord(parsed)) {
      throw new SyntaxError('config.json is not a JSON object');
    }
  } catch {
    const bak = `${configJson}.bak-${Date.now()}`;
    let backedUp = false;
    try {
      await fs.promises.rename(configJson, bak);
      backedUp = true;
    } catch {
      /* 退避に失敗しても CONFIG_CORRUPT は投げる */
    }
    throw new MnemoError(
      'CONFIG_CORRUPT',
      `${configJson} が壊れています。${backedUp ? `${bak} に退避しました。` : ''}` +
        `{ "v":1, "createdAt": "<ISO>", "updatedAt": "<ISO>" } を手で書くか init で再整備してください`,
      { configJson, backup: backedUp ? bak : null },
    );
  }

  return parsed as unknown as Config;
}

/**
 * `<projectRoot>/.mnemotheca/config.json` を更新する(設計 §8-B)。
 *
 * 現在値に `cfg` をマージし、`updatedAt` を除くフィールドに実変更があるときだけ
 * `updatedAt` を現在時刻に更新して atomic write する。実変更がゼロなら **ファイルに触れない**
 * (バイト列・`updatedAt` 不変 = git churn 不変条件)。
 */
export async function saveConfig(projectRoot: string, cfg: Partial<Config>): Promise<Config> {
  const { configJson } = mnemothecaPaths(projectRoot);
  const current = await loadConfig(projectRoot);

  // `updatedAt` は「実変更」の判定材料にしない(設計 §8-B)。
  const incoming: Record<string, unknown> = { ...cfg };
  delete incoming.updatedAt;

  const merged: Record<string, unknown> = { ...current, ...incoming };

  const keys = new Set<string>([...Object.keys(current), ...Object.keys(incoming)]);
  keys.delete('updatedAt');
  let changed = false;
  for (const k of keys) {
    if (merged[k] !== (current as unknown as Record<string, unknown>)[k]) {
      changed = true;
      break;
    }
  }

  if (!changed) {
    return current;
  }

  merged.updatedAt = new Date().toISOString();
  const next = merged as unknown as Config;
  await atomicWrite(configJson, serialize(next));
  return next;
}

/**
 * `<projectRoot>/vault/.mnemotheca-vault.json` を読む(設計 §8-B)。
 * 無い / 読めない / JSON 破損 → `null`(マーカー欠落は動作を止めない・警告レベル)。
 */
export async function readVaultMarker(projectRoot: string): Promise<VaultMarker | null> {
  const { markerJson } = vaultPaths(projectRoot);
  let raw: string;
  try {
    raw = await fs.promises.readFile(markerJson, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return null;
    }
    return parsed as unknown as VaultMarker;
  } catch {
    return null;
  }
}

/**
 * `<projectRoot>/vault/.mnemotheca-vault.json` を初回のみ生成する(設計 §8-B / §9-3)。
 * 既にマーカーが存在するなら何もしない(`createdAt` 保持 = 冪等)。
 */
export async function writeVaultMarker(projectRoot: string): Promise<void> {
  const existing = await readVaultMarker(projectRoot);
  if (existing !== null) {
    return;
  }
  const { markerJson } = vaultPaths(projectRoot);
  const marker: VaultMarker = { v: 1, createdAt: new Date().toISOString() };
  await atomicWrite(markerJson, serialize(marker));
}
