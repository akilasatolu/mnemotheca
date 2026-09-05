// src/core/slug.ts — ファイル名 slug の生成・検証・衝突解決(設計書 §8-E / §10-2-4)。
//
// - `toSlug(title)`  : タイトル → NFKC → 小文字 → 非英数字を '-' → 連続ハイフン圧縮 →
//                      前後ハイフン除去 → 最大 60 文字。基底が空(日本語のみ等)なら 'note'。
// - `isValidSlug(s)` : `/^[a-z0-9]+(?:-[a-z0-9]+)*$/` かつ 1..80 文字。
// - `resolveCollision(dir, slug, strategy)` : 3 戦略で書き込み先を決める。
//     auto-number        … `<slug>.md` が在れば `<slug>-2.md`, `-3.md` ... を探す
//     append-to-existing … 既存があればそれを返し action:'append'(呼び出し側が本文追記)
//     abort              … 既存があれば MnemoError('SLUG_COLLISION')
//   連番付与後も 80 文字を超えないよう基底を切り詰める(設計 §8-E)。

import fs from 'node:fs';
import path from 'node:path';
import { MnemoError } from './errors.js';

/** slug の最大長。`toSlug` の生成上限は 60、`isValidSlug` / 連番付与後の上限は 80(設計 §8-E)。 */
export const SLUG_MAX_LENGTH = 80;
const SLUG_GENERATE_MAX = 60;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type CollisionStrategy = 'auto-number' | 'append-to-existing' | 'abort';

export interface CollisionResult {
  /** 'create' = 新規ファイルを作る / 'append' = 既存ファイルに追記する。 */
  action: 'create' | 'append';
  /** 書き込み先の絶対パス。 */
  absPath: string;
}

function trimHyphens(s: string): string {
  return s.replace(/^-+|-+$/g, '');
}

/**
 * タイトルからファイル名 slug の基底を生成する(設計書 §8-E)。
 * 連番・id の付与は呼び出し側の責務。
 */
export function toSlug(title: string): string {
  const base = trimHyphens(
    trimHyphens(
      title
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/-+/g, '-'),
    ).slice(0, SLUG_GENERATE_MAX),
  );
  return base === '' ? 'note' : base;
}

/** slug が妥当か(`/^[a-z0-9]+(?:-[a-z0-9]+)*$/` かつ 1..80 文字)。 */
export function isValidSlug(s: string): boolean {
  return s.length >= 1 && s.length <= SLUG_MAX_LENGTH && SLUG_RE.test(s);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 書き込み先 `<dir>/<slug>.md` の衝突を 3 戦略で解決する(設計書 §8-E / §8-M)。
 *
 * @throws MnemoError('SLUG_COLLISION') strategy='abort' で既存衝突、または連番が上限に達したとき。
 */
export async function resolveCollision(
  dir: string,
  slug: string,
  strategy: CollisionStrategy,
): Promise<CollisionResult> {
  const primary = path.join(dir, `${slug}.md`);

  if (!(await pathExists(primary))) {
    return { action: 'create', absPath: primary };
  }

  if (strategy === 'abort') {
    throw new MnemoError('SLUG_COLLISION', `slug "${slug}" は既に存在します`, {
      dir,
      slug,
      existing: primary,
    });
  }

  if (strategy === 'append-to-existing') {
    return { action: 'append', absPath: primary };
  }

  // auto-number: <slug>-2.md, -3.md ... を探す。
  for (let n = 2; n <= 9999; n += 1) {
    const suffix = `-${n}`;
    const trimmed =
      slug.length + suffix.length > SLUG_MAX_LENGTH
        ? slug.slice(0, SLUG_MAX_LENGTH - suffix.length)
        : slug;
    const candidate = path.join(dir, `${trimmed}${suffix}.md`);
    if (!(await pathExists(candidate))) {
      return { action: 'create', absPath: candidate };
    }
  }

  throw new MnemoError('SLUG_COLLISION', `slug "${slug}" の連番が上限に達しました`, { dir, slug });
}
