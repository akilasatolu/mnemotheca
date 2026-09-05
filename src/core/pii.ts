// src/core/pii.ts — PII / クレデンシャル セーフティネット(設計書 §7・確定)。
//
// Claude の一次チェック(文脈判断・必須・設計外)をすり抜けた**明白なクレデンシャル**を
// サーバー側で機械的に止める二層防御。日本語の氏名・住所は正規表現では追わない
// (誤検知・見逃し双方が多い。設計 §7 でスコープ外)。
//
// 純関数(I/O なし)。
//
// **インラインフラグ厳禁**: Node 20 の V8 は `(?i)` `(?m)` `(?s)` `(?i:...)` を SyntaxError にする。
// 本ファイルの全 `re` はインラインフラグを一切含まず、フラグは `RegExp` の第 2 引数で与える
// (`g` 必須、大小無視が要るものは `gi`)。
//
// 評価順(§7-2 末尾): 各パターンごとに `re.lastIndex = 0` にリセット → `matchAll` で全マッチ →
//   `requireNearby` があれば前後 200 文字窓に `.test()`、不一致なら捨てる →
//   `demoteIf` を評価して severity を確定(block→warn、warn→不採用)→ 結果に積む。

/** マッチ位置前後の近傍窓(文字数)。`requireNearby` はこの窓に対して評価する。 */
const NEARBY_WINDOW = 200;

export interface PiiPattern {
  name: string;
  /** フラグは `RegExp` 第 2 引数で(`g` 必須)。インラインフラグ禁止。 */
  re: RegExp;
  severity: 'block' | 'warn';
  /** マッチ位置の前後 200 文字にこれが無ければ不採用(ノイズ抑制)。 */
  requireNearby?: RegExp;
  /** true なら severity を一段下げる(block→warn、warn→不採用)。 */
  demoteIf?: (matchedValue: string, fullText: string) => boolean;
}

export interface PiiHit {
  pattern: string;
  /** 生値は残さない。先頭 4 文字 + `***`。 */
  masked: string;
  noteSlug?: string;
  line?: number;
}

export interface PiiResult {
  blocks: PiiHit[];
  warns: PiiHit[];
}

/**
 * プレースホルダ判定(設計 §7-2)。次のいずれかで true:
 * - `your_` / `xxxxx` / `<` / `>` / `changeme` / `example` / `dummy` / `placeholder` / `redacted` を含む
 * - 同一文字の繰り返しのみ
 * - 12 文字未満
 */
export function isPlaceholder(value: string): boolean {
  if (value.length < 12) return true;
  if (/^(.)\1*$/.test(value)) return true;
  const lower = value.toLowerCase();
  const needles = [
    'your_',
    'xxxxx',
    '<',
    '>',
    'changeme',
    'example',
    'dummy',
    'placeholder',
    'redacted',
  ];
  return needles.some((n) => lower.includes(n));
}

/** クレジットカード番号の Luhn チェック。区切り文字は無視。 */
function luhnValid(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 16) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

// ── BLOCK パターン(高信頼・クレデンシャル。設計 §7-2 の 13 種)────────────────
// 正規表現は設計書どおり。勝手に足さない・変えない。
export const BLOCK_PATTERNS: PiiPattern[] = [
  {
    name: 'aws-access-key-id',
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gi,
    severity: 'block',
  },
  {
    name: 'aws-secret-access-key',
    re: /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/gi,
    severity: 'block',
    // 近傍 200 字に aws/secret/access key が無ければ不採用(40 字 base64 の誤爆を防ぐ)。
    requireNearby: /aws|secret|access[_ -]?key/i,
  },
  {
    name: 'openai-key',
    re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/gi,
    severity: 'block',
    demoteIf: isPlaceholder,
  },
  {
    name: 'anthropic-key',
    re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/gi,
    severity: 'block',
  },
  {
    name: 'github-token',
    re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/gi,
    severity: 'block',
  },
  {
    name: 'gitlab-token',
    re: /\bglpat-[A-Za-z0-9_-]{20,}\b/gi,
    severity: 'block',
  },
  {
    name: 'slack-token',
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gi,
    severity: 'block',
  },
  {
    name: 'google-api-key',
    re: /\bAIza[0-9A-Za-z_-]{35}\b/gi,
    severity: 'block',
  },
  {
    name: 'stripe-key',
    re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{24,}\b/gi,
    severity: 'block',
  },
  {
    name: 'private-key-block',
    re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/gi,
    severity: 'block',
  },
  {
    name: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gi,
    severity: 'block',
  },
  {
    name: 'generic-secret-assignment',
    re: /\b(?:api[_-]?key|secret|password|passwd|token|access[_-]?token|client[_-]?secret|bearer)\b["'\s:=]{1,4}["']?([A-Za-z0-9/_+=.\-]{12,})["']?/gi,
    severity: 'block',
    // キャプチャ 1(= 値)で判定。
    demoteIf: isPlaceholder,
  },
  {
    name: 'npm-token',
    re: /\bnpm_[A-Za-z0-9]{36}\b/gi,
    severity: 'block',
  },
];

// ── WARN パターン(PII 様・文脈判断不能。設計 §7-3 の 7 種)────────────────────
// `phone-jp` は設計で 2 本の正規表現なので 2 エントリに分割(固定電話 / 携帯)。
// `ipv4-private-excluded` は設計で「対象外」のため実装しない。
export const WARN_PATTERNS: PiiPattern[] = [
  {
    name: 'email',
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gi,
    severity: 'warn',
  },
  {
    name: 'phone-jp',
    re: /\b0\d{1,4}-\d{1,4}-\d{3,4}\b/g,
    severity: 'warn',
  },
  {
    name: 'phone-jp-mobile',
    re: /\b0[789]0-?\d{4}-?\d{4}\b/g,
    severity: 'warn',
  },
  {
    name: 'phone-intl',
    re: /\+\d{1,3}[\s-]?\d{1,4}[\s-]?\d{2,4}[\s-]?\d{2,4}\b/g,
    severity: 'warn',
  },
  {
    name: 'credit-card',
    re: /\b(?:\d[ -]?){13,16}\b/g,
    severity: 'warn',
    // Luhn チェック非通過なら不採用(= warn からさらに降格)。
    demoteIf: (value) => !luhnValid(value),
  },
  {
    name: 'my-number-jp',
    re: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
    severity: 'warn',
  },
  {
    name: 'jp-postal',
    re: /\b〒?\d{3}-\d{4}\b/g,
    severity: 'warn',
  },
];

/** 全パターン(BLOCK → WARN の順)。§13-7 の健全性テストが全件を走査する。 */
export const PII_PATTERNS: PiiPattern[] = [...BLOCK_PATTERNS, ...WARN_PATTERNS];

/** 生値を残さないマスク: 先頭 4 文字 + `***`。 */
function mask(value: string): string {
  return `${value.slice(0, 4)}***`;
}

/** 0-based の文字インデックスから 1-based の行番号を求める。 */
function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

/**
 * テキストを全パターンで 1 パス走査し、BLOCK / WARN ヒットを返す(設計 §7-4)。
 *
 * - `requireNearby`: マッチ前後 200 文字窓に無ければ不採用。
 * - `demoteIf`: true なら severity を一段下げる(block→warn、warn→不採用)。
 *   `generic-secret-assignment` はキャプチャ 1(値)で判定。
 * - 生値は戻り値・ログに残さない(`masked` のみ)。
 */
export function scanPii(text: string, ctx?: { noteSlug?: string }): PiiResult {
  const blocks: PiiHit[] = [];
  const warns: PiiHit[] = [];
  if (typeof text !== 'string' || text.length === 0) return { blocks, warns };

  for (const pattern of PII_PATTERNS) {
    pattern.re.lastIndex = 0;
    for (const m of text.matchAll(pattern.re)) {
      const full = m[0];
      const idx = m.index ?? 0;
      // demoteIf / マスク対象の値: キャプチャ 1 があればそれ、無ければ全マッチ。
      const value = m[1] ?? full;

      if (pattern.requireNearby) {
        const from = Math.max(0, idx - NEARBY_WINDOW);
        const to = idx + full.length + NEARBY_WINDOW;
        const window = text.slice(from, to);
        pattern.requireNearby.lastIndex = 0;
        if (!pattern.requireNearby.test(window)) continue;
      }

      let severity: 'block' | 'warn' | 'drop' = pattern.severity;
      if (pattern.demoteIf?.(value, text)) {
        severity = severity === 'block' ? 'warn' : 'drop';
      }
      if (severity === 'drop') continue;

      const hit: PiiHit = {
        pattern: pattern.name,
        masked: mask(value),
        line: lineOf(text, idx),
      };
      if (ctx?.noteSlug !== undefined) hit.noteSlug = ctx.noteSlug;

      (severity === 'block' ? blocks : warns).push(hit);
    }
    pattern.re.lastIndex = 0;
  }

  return { blocks, warns };
}
