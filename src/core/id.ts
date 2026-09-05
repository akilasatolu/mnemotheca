// src/core/id.ts — ノートの不変 `id` の生成(設計書 §8-F / §10-2-4)。
//
// 形式: `YYYYMMDD'T'HHMMSSSSS`(コロン無しのローカル時刻。8 桁 + 'T' + 9 桁)+ base36 5 文字。
//   例: 20260901T093015123k7f2a
// - レキシカルソート = 時刻順(先頭のタイムスタンプが厳密に昇順)。
// - ファイル名にも使える(記号なし)。ファイル名は別途 slug を使うため id は表示に出ない。
//
// 一意性(設計 §8-F の制約): 同一ミリ秒で 1000 回呼んでも重複しないこと。
//   末尾 5 文字を「同一タイムスタンプ内の連番(base36 2 文字 = 0..1295)+ 乱数 3 文字」に分割し、
//   連番部だけで最大 1296 個の一意性を保証する(1000 < 1296)。乱数部は追加のエントロピー。

import { randomInt } from 'node:crypto';

const B36 = '0123456789abcdefghijklmnopqrstuvwxyz';

/** id 全体の形式(8 桁日付 + 'T' + 9 桁時刻 + base36 5 文字)。 */
export const ID_PATTERN = /^[0-9]{8}T[0-9]{9}[a-z0-9]{5}$/;

/** 同一タイムスタンプ内での呼び出し連番(タイムスタンプが変わるとリセット)。 */
let lastStamp = '';
let seq = 0;

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

/** 非負整数 `n` を base36 で `width` 文字にゼロ詰めする(下位 `width` 桁のみ)。 */
function toBase36(n: number, width: number): string {
  let v = Math.abs(Math.trunc(n));
  let out = '';
  for (let i = 0; i < width; i++) {
    out = B36.charAt(v % 36) + out;
    v = Math.floor(v / 36);
  }
  return out;
}

/**
 * 新しいノート id を生成する(設計書 §8-F)。
 *
 * @param d 基準日時。既定は現在時刻。テストで固定 Date を渡せる。
 * @returns `ID_PATTERN` にマッチする 22 文字の文字列。
 */
export function newId(d: Date = new Date()): string {
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1, 2)}${pad(d.getDate(), 2)}` +
    `T${pad(d.getHours(), 2)}${pad(d.getMinutes(), 2)}${pad(d.getSeconds(), 2)}${pad(d.getMilliseconds(), 3)}`;

  if (stamp === lastStamp) {
    seq += 1;
  } else {
    lastStamp = stamp;
    seq = 0;
  }

  // 連番部: 同一タイムスタンプ内で 0..1295 まで一意(1296 = 36^2)。
  const counterPart = toBase36(seq % (36 * 36), 2);
  // 乱数部: 追加エントロピー(base36 3 文字)。
  let randPart = '';
  for (let i = 0; i < 3; i += 1) {
    randPart += B36.charAt(randomInt(36));
  }

  return stamp + counterPart + randPart;
}
