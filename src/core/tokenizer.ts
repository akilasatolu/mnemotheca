// src/core/tokenizer.ts — 日本語 bigram トークナイザ / MiniSearch 用 term プロセッサ(設計書 §5)。
//
// 純関数のみ(I/O なし)。MiniSearch 7.x は index 時と search 時で `processTerm` の
// 呼ばれ方が違う(index: `processTerm(term, field)` / search: `processTerm(term)`)ため、
// term プロセッサを 2 本に分ける:
//   - `processTermIndex(term, field?)` … index 時。content/summary のときだけストップワード除外。
//                                        title/tags/categories は記号のみ落とす。
//   - `processTermSearch(term)`         … search 時。field によらず常にストップワード除外。
//
// `tokenize(text, field?)` は field で分岐しない(設計 §5-1)。ストップワード除外は
// `tokenize` では行わず、MiniSearch の `processTerm` に一本化する(設計 §5-1 step6)。

/** トークナイザ仕様のバージョン。§5 の仕様を変えたら +1(設計 §5-5)。 */
export const TOKENIZER_VERSION = 1;

/**
 * 「記号のみ / 無意味トークン」判定用パターン(設計 §5-1 step6 / §5-2)。
 * 英数字・ひらがな・カタカナ・CJK 統合漢字・々〆ヵヶ をいずれも含まないトークンは棄却する。
 */
const NOISE_RE = /^[^a-z0-9ぁ-んァ-ヶ一-龠々〆ヵヶ]+$/;

/**
 * 英数字ラン(1 トークンとして採用。bigram 化しない)。
 * `gpt-4o` / `mcp2.0` / `node.js` のように内部の `- _ . + #` は語構成として保持する
 * (設計 §5-1 step3-4 / §5-3)。
 */
const WORD_RE = /[a-z0-9]+(?:[-_.+#][a-z0-9]+)*/g;

/**
 * 非英数字ラン内の区切り(空白・句読点・記号)。bigram を境界またぎで作らない(設計 §5-1 step3)。
 * カタカナ長音符 `ー` は語構成要素なので **含めない**。
 */
const SEP_RE =
  /[\s　、。，．・「」『』【】〔〕（）()［］\[\]｛｝{}〈〉《》<>"'“”‘’`~〜…—―‐\-_＿/\\|!！?？;；:：,.*#＃@＠&＆%％$＄^＾+＋=＝]+/;

/**
 * 英語ストップワード。設計 §5-2 に明示列挙されている語のみ(勝手に足さない)。
 * ※ 設計本文は「計 46 語」と書くが、列挙されているのは以下 32 語。差分あり。
 */
const EN_STOPWORDS = new Set<string>([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'else', 'for', 'to', 'of',
  'in', 'on', 'at', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'this', 'that', 'these', 'those', 'with', 'as', 'it', 'its', 'from',
]);

/**
 * 日本語 1 文字助詞(設計 §5-2)。名詞的 1 文字(漢字・カタカナ)はここに入れない = 残す。
 */
const JP_PARTICLES_1CHAR = new Set<string>([
  'は', 'を', 'に', 'が', 'の', 'へ', 'と', 'で', 'や', 'も', 'か', 'ね', 'よ',
]);

/** トークンが空文字 or 記号のみなら true(設計 §5-1 step6)。 */
function isNoise(term: string): boolean {
  return term === '' || NOISE_RE.test(term);
}

/**
 * term が「除外すべきストップワード / 無意味トークン」なら true(設計 §5-2 共通ヘルパ)。
 */
function isStopOrNoise(term: string): boolean {
  const t = term.trim();
  if (t === '') return true;
  if (EN_STOPWORDS.has(t)) return true;
  if (JP_PARTICLES_1CHAR.has(t)) return true;
  if (NOISE_RE.test(t)) return true;
  return false;
}

/** 非英数字ラン(CJK・かな・その他)を bigram 化して push する(設計 §5-1 step5)。 */
function pushCjkSegment(segment: string, out: string[]): void {
  for (const frag of segment.split(SEP_RE)) {
    if (frag.length === 0) continue;
    if (frag.length === 1) {
      // n === 1: 1 文字クエリでも最低限ヒットさせるためそのまま採用。
      if (!isNoise(frag)) out.push(frag);
      continue;
    }
    // n >= 2: 連続する 2 文字の重なり列(bigram)。例「機械学習」→ 機械 / 械学 / 学習
    for (let k = 0; k + 1 < frag.length; k += 1) {
      const bigram = frag.slice(k, k + 2);
      if (!isNoise(bigram)) out.push(bigram);
    }
  }
}

/**
 * テキストをトークン列へ(設計 §5-1)。
 *
 * 処理順:
 *  1. NFKC 正規化 → 全角英数字・半角カナを標準形へ。
 *  2. 小文字化。
 *  3. 英数字ラン(`- _ . + #` を語内に許容)は 1 トークン。長さ 1 も採用。
 *  4. それ以外の連続文字は区切り(空白・記号)で分割し、各断片を bigram 化。1 文字は素通し。
 *  5. 空文字・記号のみのトークンは棄却。重複はそのまま返す(MiniSearch が TF として扱う)。
 *
 * ストップワード除外はここでは行わない(設計 §5-1 step6)。`field` 引数は使わない
 * (MiniSearch が `tokenize(text, fieldName?)` の形で呼ぶための受け口。§5-1)。
 */
export function tokenize(text: string, _field?: string): string[] {
  const normalized = text.normalize('NFKC').toLowerCase();
  const tokens: string[] = [];

  WORD_RE.lastIndex = 0;
  let lastIndex = 0;
  let m: RegExpExecArray | null = WORD_RE.exec(normalized);
  while (m !== null) {
    const word = m[0];
    const gap = normalized.slice(lastIndex, m.index);
    if (gap.length > 0) pushCjkSegment(gap, tokens);
    if (!isNoise(word)) tokens.push(word);
    lastIndex = m.index + word.length;
    m = WORD_RE.exec(normalized);
  }
  const tail = normalized.slice(lastIndex);
  if (tail.length > 0) pushCjkSegment(tail, tokens);

  return tokens;
}

/**
 * index 時の term プロセッサ(設計 §5-2-1)。MiniSearch `options.processTerm` に設定する。
 *
 *  - `term.trim()` が空 → `null`。
 *  - `field` が `content` / `summary` のときだけストップワード除外(`isStopOrNoise`)。
 *  - それ以外の field(`title` / `tags` / `categories` / `undefined`)は記号のみのとき `null`。
 *    タイトルやタグの助詞・短語は識別情報になり得るため残す。
 *  - 落ちなければ term をそのまま返す。
 */
export function processTermIndex(term: string, field?: string): string | null {
  const t = term.trim();
  if (t === '') return null;
  if (field === 'content' || field === 'summary') {
    return isStopOrNoise(t) ? null : t;
  }
  return NOISE_RE.test(t) ? null : t;
}

/**
 * search 時の term プロセッサ(設計 §5-2-2)。MiniSearch `searchOptions.processTerm` に
 * **明示設定**する(渡し忘れると `processTermIndex` に field なしでフォールバックし、
 * クエリ側の助詞が除去されず `combineWith:'AND'` が破綻する)。
 *
 * field が渡らないため、**field によらず常にストップワードを除外**する。
 */
export function processTermSearch(term: string): string | null {
  return isStopOrNoise(term) ? null : term.trim();
}
