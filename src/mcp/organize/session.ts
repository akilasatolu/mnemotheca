// src/mcp/organize/session.ts — `organize-session.json` の read / write / 破損退避ヘルパ
// (設計書 §10-5 スキーマ / §8-N scan 冒頭チェック / §12-10 クラッシュ復帰)。
//
// **session I/O 専用**。提案ロジック(detect / scan)や apply / undo の処理は一切持たない。
// scan が新規セッションを書き、preview / apply / undo が同じファイルを読んで
// `proposals` を照合キー(`sessionId` / `expiresAt`)込みで参照する。
//
// 破損退避パターンは `config.json`(§8-B)/ `usage_log`(§8-I)/ index(§12-11)と同一:
// JSON パース不能 or 形が壊れている → `<file>.corrupt-<ts>` にリネームして「セッション無し」扱い。

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { newId } from '../../core/id.js';
import { mnemothecaPaths } from '../../core/paths.js';
import type { OrganizeProposal } from './scan.js';

/** `organize-session.json` の形式バージョン(設計書 §10-5 `v`)。 */
export const SESSION_FORMAT_VERSION = 1;

/** セッションの寿命(設計書 §10-5 `expiresAt` = `scannedAt` + 24h)。 */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** `<indexDir>/organize-session.json` の中身(設計書 §10-5。余計なフィールドを足さない)。 */
export interface OrganizeSession {
  /** 形式バージョン。常に `1`。 */
  v: number;
  /** `org-` + `newId()`。preview / apply が照合(不一致 → `ORGANIZE_SESSION_EXPIRED`)。 */
  sessionId: string;
  /** scan 実行時刻(ISO8601)。 */
  scannedAt: string;
  /** scan が返した提案定義。preview / apply はこれを正とする。 */
  proposals: OrganizeProposal[];
  /** `scannedAt` + 24h。超過後の preview / apply は `ORGANIZE_SESSION_EXPIRED`。 */
  expiresAt: string;
  /** 破壊的変更(FileOp)の実行中フラグ。既定 `false`。`true` 残存 = 前回 apply がクラッシュ。 */
  applying: boolean;
  /** `applying:true` のときの `restoreSnapshot` 対象(`<label>-<ts>`)。それ以外は `null`。 */
  snapshotId: string | null;
}

/** `readSession` の結果。`corruptedTo` は破損退避したファイルの basename(退避しなければ `null`)。 */
export interface ReadSessionResult {
  session: OrganizeSession | null;
  corruptedTo: string | null;
}

/** `org-` + `newId()`(設計書 §10-5 `sessionId`)。`now` を基準に採番する(乱数なしの純度は不要)。 */
export function newSessionId(now: number): string {
  return `org-${newId(new Date(now))}`;
}

/** `now` がセッションの `expiresAt` を過ぎているか(`expiresAt` がパース不能なら失効扱い)。 */
export function isSessionExpired(session: OrganizeSession, now: number): boolean {
  const expiresMs = Date.parse(session.expiresAt);
  return Number.isNaN(expiresMs) || now > expiresMs;
}

/** scan 完了時に書き込む新規セッション(`applying:false` 初期化・TTL 24h。設計書 §10-5 step1)。 */
export function buildSession(
  sessionId: string,
  scannedAt: string,
  proposals: OrganizeProposal[],
): OrganizeSession {
  const scannedMs = Date.parse(scannedAt);
  const base = Number.isNaN(scannedMs) ? Date.now() : scannedMs;
  return {
    v: SESSION_FORMAT_VERSION,
    sessionId,
    scannedAt,
    proposals,
    expiresAt: new Date(base + SESSION_TTL_MS).toISOString(),
    applying: false,
    snapshotId: null,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** パース済み JSON を `OrganizeSession` へ。必須キーの型が合わなければ `null`(= 破損扱い)。 */
function coerceSession(parsed: unknown): OrganizeSession | null {
  if (!isRecord(parsed)) return null;
  const { sessionId, scannedAt, proposals, expiresAt, applying, snapshotId } = parsed;
  if (typeof sessionId !== 'string' || sessionId === '') return null;
  if (typeof scannedAt !== 'string') return null;
  if (typeof expiresAt !== 'string') return null;
  if (typeof applying !== 'boolean') return null;
  if (!Array.isArray(proposals)) return null;
  if (snapshotId !== null && typeof snapshotId !== 'string') return null;
  return {
    v: typeof parsed.v === 'number' ? parsed.v : SESSION_FORMAT_VERSION,
    sessionId,
    scannedAt,
    proposals: proposals as OrganizeProposal[],
    expiresAt,
    applying,
    snapshotId,
  };
}

/**
 * `organize-session.json` を読む(設計書 §8-N scan step0 / §10-5)。
 * - ファイル無し → `{ session: null, corruptedTo: null }`。
 * - JSON パース不能 / 形が壊れている → `<file>.corrupt-<ts>` へリネーム退避し
 *   `{ session: null, corruptedTo: <basename> }`(退避自体の失敗は握りつぶす)。
 */
export async function readSession(projectRoot: string): Promise<ReadSessionResult> {
  const file = mnemothecaPaths(projectRoot).organizeSessionJson;

  let raw: string;
  try {
    raw = await fs.promises.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { session: null, corruptedTo: null };
    }
    throw err;
  }

  let session: OrganizeSession | null = null;
  try {
    session = coerceSession(JSON.parse(raw));
  } catch {
    session = null;
  }
  if (session !== null) {
    return { session, corruptedTo: null };
  }

  const dest = `${file}.corrupt-${Date.now()}`;
  try {
    await fs.promises.rename(file, dest);
  } catch {
    /* 退避失敗は致命的でない(セッション無しとして続行する) */
  }
  return { session: null, corruptedTo: path.basename(dest) };
}

/**
 * `organize-session.json` を atomic に書き込む(`.tmp-<rand>` → rename。設計書 §10-5 step1 / step6)。
 * index ディレクトリが無ければ作成する。
 */
export async function writeSession(projectRoot: string, session: OrganizeSession): Promise<void> {
  const file = mnemothecaPaths(projectRoot).organizeSessionJson;
  const dir = path.dirname(file);
  await fs.promises.mkdir(dir, { recursive: true });

  const tmp = path.join(dir, `.organize-session.json.tmp-${randomBytes(6).toString('hex')}`);
  try {
    await fs.promises.writeFile(tmp, `${JSON.stringify(session, null, 2)}\n`, 'utf8');
    await fs.promises.rename(tmp, file);
  } finally {
    await fs.promises.rm(tmp, { force: true }).catch(() => {
      /* 掃除失敗は致命的でない */
    });
  }
}
