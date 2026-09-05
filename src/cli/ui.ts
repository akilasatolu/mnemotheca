// src/cli/ui.ts — CLI 出力の色付け・整形(設計書 §9-1 グローバルオプション / §12-1 CLI 面)。
//
// I/O はしない。`picocolors` で色付けした文字列を返すだけの純関数群 +
// `MnemoError` を CLI 提示用テキスト / `--json` オブジェクトへ整形するヘルパー。
// 実際の stderr/stdout 書き込みと exit code の決定は `cli/index.ts` が担当する。
//
// 色が有効かどうか(TTY / `FORCE_COLOR` / `NO_COLOR` / `CI`)は `picocolors` が
// モジュールロード時に決める。非対話・パイプ時は自動でプレーン文字列になる。

import pc from 'picocolors';
import type { ErrorCode } from '../core/errors.js';
import { formatMnemoError, type MnemoErrorLike } from '../mcp/format.js';

/** 色が有効か(テスト側の期待値切り替え用)。 */
export const colorEnabled: boolean = pc.isColorSupported;

/** エラー系(赤)。 */
export function error(msg: string): string {
  return pc.red(msg);
}

/** 成功系(緑)。 */
export function success(msg: string): string {
  return pc.green(msg);
}

/** 警告系(黄)。 */
export function warn(msg: string): string {
  return pc.yellow(msg);
}

/** 通常の情報(装飾なし)。 */
export function info(msg: string): string {
  return msg;
}

/** 補足・弱調(dim)。 */
export function dim(msg: string): string {
  return pc.dim(msg);
}

/** 強調(bold)。 */
export function bold(msg: string): string {
  return pc.bold(msg);
}

/**
 * `MnemoError.code` ごとの「次のコマンドで解決できます: …」提示(設計書 §12-1)。
 * 単一コマンドで直せない code は案内行を出さない(`formatMnemoError` の「対処:」行に委ねる)。
 */
const RESOLVE_COMMAND: Partial<Record<ErrorCode, string>> = {
  NOT_INITIALIZED: 'mnemo init',
  CONFIG_CORRUPT: 'mnemo doctor',
  NODE_MODULES_MISSING: 'npm install',
  VAULT_UNAVAILABLE: 'mnemo doctor --fix',
  VAULT_NOT_WRITABLE: 'mnemo doctor',
  INDEX_BUILD_FAILED: 'mnemo reindex --full',
  RUNTIME_DIR_UNWRITABLE: 'MNEMO_RUNTIME_DIR=<書き込み可能なパス> mnemo doctor',
};

/**
 * `MnemoError` を CLI の stderr 提示用テキストに整形する(設計書 §12-1)。
 * 「説明 + 対処(`mcp/format.ts` の `formatMnemoError` を流用)」+ 必要なら
 * 「次のコマンドで解決できます: …」を付け、全体を赤字にする。
 */
export function renderMnemoError(err: MnemoErrorLike): string {
  const lines = [formatMnemoError(err)];
  const cmd = RESOLVE_COMMAND[err.code];
  if (cmd !== undefined) {
    lines.push(`次のコマンドで解決できます: ${cmd}`);
  }
  return pc.red(lines.join('\n'));
}

/** `--json` 時のエラー出力形(設計書 §10-1 のエラー形式に合わせる)。 */
export interface CliErrorJson {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

/** `MnemoError`(または想定外エラー)を `--json` 用オブジェクトへ。 */
export function errorToJson(err: MnemoErrorLike): CliErrorJson {
  return {
    error: {
      code: err.code,
      message: err.message ?? err.code,
      ...(err.details !== undefined ? { details: err.details } : {}),
    },
  };
}
