// src/core/similarity.ts — organize の決定論的な重複・類似判定(設計書 §8-K)。
//
// 純関数のみ(I/O なし)。organize の scan(§8-N)が「重複タイトル」「同一コピー」
// 「本文が近い統合候補」「_uncategorized の振り分け候補」を機械判定するための素材を提供する。
//
// しきい値(0.60 等)はここには持たない。判定の値そのものは `core/organize-config.ts` の
// `ORGANIZE_THRESHOLDS` を参照する(呼び出し側 / テストが定数経由で比較する)。ここは
// 「キー化」「ハッシュ化」「Jaccard 係数」という決定論的な計算だけを担う。

import { createHash } from 'node:crypto';
import { tokenize } from './tokenizer.js';

/**
 * タイトルの正規化キー(設計書 §8-K)。
 *
 * `NFKC` 正規化 → 小文字化 → 文字(`\p{L}`)・数字(`\p{N}`)以外を全除去。
 * 空白・記号・約物・全半角の違いを吸収し、`titleKey` が一致すれば「同じタイトル」と
 * みなせる(`ORGANIZE_THRESHOLDS.duplicateTitleExact`)。
 *
 * 例:
 *  - `"AWS  MCP: 実現可能性!"`  → `"awsmcp実現可能性"`
 *  - `"aws-mcp（実現可能性）"`   → `"awsmcp実現可能性"`
 */
export function titleKey(title: string): string {
  return title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * 本文の空白差を吸収した内容ハッシュ(設計書 §8-K)。
 *
 * `NFKC` 正規化 → 改行(`\r\n` / `\r`)を含むあらゆる連続空白を単一スペースへ圧縮 →
 * 前後の空白を除去 → その文字列の `sha256` 16 進ダイジェスト。
 *
 * インデント・改行・全角/半角スペースの違いしかない 2 本文は同一ハッシュになる
 * (`ORGANIZE_THRESHOLDS.duplicateBodyHashExact` = conflict copy 疑い)。
 */
export function bodyHash(body: string): string {
  const normalized = body
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim();
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * テキストを bigram(＋英数字ラン)トークンの集合へ(設計書 §8-K)。
 *
 * `core/tokenizer.ts` の `tokenize`(日本語 bigram / 英数字ランは 1 トークン、
 * 記号のみは棄却)をそのまま利用し、TF を落として集合化する。
 */
export function toBigramSet(text: string): Set<string> {
  return new Set(tokenize(text));
}

/**
 * 2 集合の Jaccard 係数 `|A ∩ B| / |A ∪ B|`(0〜1、設計書 §8-K)。
 *
 * 慣例に従い、両方が空集合のときは「差が無い」= `1` を返す
 * (`J(∅, ∅) = 1`)。片方だけ空なら `0`。
 */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let intersection = 0;
  for (const x of small) {
    if (large.has(x)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

/**
 * タグ配列同士の Jaccard 係数(設計書 §8-K)。
 *
 * 各タグを trim し空文字を除いて集合化してから `jaccard` を取る。
 * 例: `["a","b","c"]` vs `["b","c","d"]` → `0.5`。
 */
export function tagJaccard(a: string[], b: string[]): number {
  return jaccard(toTagSet(a), toTagSet(b));
}

function toTagSet(tags: string[]): Set<string> {
  const set = new Set<string>();
  for (const tag of tags) {
    const trimmed = tag.trim();
    if (trimmed !== '') set.add(trimmed);
  }
  return set;
}

/**
 * 2 本文の bigram 集合 Jaccard 係数(設計書 §8-K)。
 *
 * `toBigramSet` + `jaccard`。同一本文なら `1.0`、無関係なら低い値。
 * organize の統合候補判定は呼び出し側で
 * `bigramJaccard(...) >= ORGANIZE_THRESHOLDS.mergeCandidateBigramJaccard` を評価する。
 */
export function bigramJaccard(aBody: string, bBody: string): number {
  return jaccard(toBigramSet(aBody), toBigramSet(bBody));
}
