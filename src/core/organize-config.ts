// src/core/organize-config.ts — organize のしきい値・ヒューリスティクス定数の一元管理
// (設計書 §8-K『しきい値(初期値・確定)』+ 付録 C『ORGANIZE_HEURISTICS_VERSION』)。
//
// 純粋な定数モジュール(I/O・ロジックなし)。organize の機械検出ロジック本体
// (split-category / merge-file / move-uncategorized / stale-content 判定など、
// 設計書 §8-N の scan)は `src/mcp/organize/scan.ts` 側に置く。
// ここはその判定が参照するしきい値の「値」だけを保持する。
//
// これらの値は実データで再調整されうるが、初期値は設計書で確定している。
// 値を変更したら `ORGANIZE_HEURISTICS_VERSION` を +1 すること
// (設計書 付録 C: 「変更は ORGANIZE_HEURISTICS_VERSION 定数(1 から開始)で管理する」)。

/**
 * organize の決定論的な検出しきい値(設計書 §8-K)。
 *
 * - `subdivideMinFiles`            … 同一クラスタ(共通タグ / タイトル bigram クラスタ)が
 *                                    この件数以上で split-category(サブディレクトリ化)を提案。
 * - `mergeCandidateBigramJaccard`  … 本文 bigram Jaccard がこの値以上で merge-file 統合候補
 *                                    (`core/similarity` の `bigramJaccard`。0〜1)。
 * - `duplicateTitleExact`          … `titleKey`(§8-K)完全一致を重複候補として扱うか。
 * - `duplicateBodyHashExact`       … `bodyHash`(§8-K)一致を「同一コピー」= conflict copy
 *                                    疑いとして扱うか。
 * - `uncategorizedAssignMinJaccard`… `_uncategorized/` の各ノートについて、既存カテゴリの
 *                                    集約 bigram 集合との Jaccard 最大値がこの値以上なら
 *                                    move-uncategorized の候補カテゴリを提示(0〜1)。
 * - `staleDays`                    … `updated` からこの日数を超え、かつ `tags` に
 *                                    `reference` / `permanent` を含まないノートを
 *                                    stale-content 候補として提示のみ行う。
 * - `clusterTagMinShare`           … split-category の追加条件。あるタグを持つファイルが
 *                                    カテゴリ内 `subdivideMinFiles` 件以上、かつカテゴリ全体の
 *                                    この割合未満のときだけ分割提案(全ノートが同じタグなら
 *                                    分ける意味がない)。0〜1。
 */
export const ORGANIZE_THRESHOLDS = {
  subdivideMinFiles: 10,
  mergeCandidateBigramJaccard: 0.6,
  duplicateTitleExact: true,
  duplicateBodyHashExact: true,
  uncategorizedAssignMinJaccard: 0.25,
  staleDays: 540,
  clusterTagMinShare: 0.5,
} as const;

/** `ORGANIZE_THRESHOLDS` のキー型。 */
export type OrganizeThresholdKey = keyof typeof ORGANIZE_THRESHOLDS;

/**
 * organize ヒューリスティクスのバージョン(設計書 付録 C)。
 *
 * `ORGANIZE_THRESHOLDS` の値やタイトル正規化ルール等、organize の判定基準を
 * 変更したらこの値を +1 する。scan 結果やキャッシュの世代管理に用いる。
 * 初期値は 1。
 */
export const ORGANIZE_HEURISTICS_VERSION = 1;
