// src/core/usage-log.ts — 利用ログ(`usage_log.jsonl`)の追記・読み取り・末尾修復・集計。
//
// 設計書 §8-I(API)/ §10-4(`UsageRecord` スキーマ・`UsageStats` 集計仕様)/ §13-6(テスト観点)。
//
// 方針:
// - `usage_log.jsonl` は append-only の JSON Lines(1 行 1 レコード、末尾改行あり)。
//   置き場所は `<projectRoot>/.mnemotheca/index/usage_log.jsonl`(設計 §4-1 / `paths.ts`)。
// - レコードに**ノート本文は一切残さない**(設計 §10-4 / §7 プライバシー要件)。概算文字数のみ。
// - 追記は `withLock(projectRoot, 'usage-log')` で直列化(設計 §8-G)。書き込み失敗は
//   ログに出すだけで上位処理は失敗させない(履歴記録は副次的)。
// - 読み取りは不正行スキップ。起動時に末尾の途中破損行を切り詰め(プロセスクラッシュ復旧)。
// - 全損(ファイルが読めない)は `usage_log.jsonl.corrupt-<ts>` に退避して空ログ扱い。
//
// 依存は node 標準 + `core/{paths,lock}` のみ(設計 §1-3)。

import fs from 'node:fs';
import path from 'node:path';
import { withLock } from './lock.js';
import { mnemothecaPaths } from './paths.js';

/** `usage_log.jsonl` の 1 レコード(設計 §10-4 / §8-I)。本文は残さない。 */
export interface UsageRecord {
  /** スキーマバージョン。現在は 1 固定。 */
  v: 1;
  /** イベント発生時刻(ISO8601 + TZ)。 */
  ts: string;
  /** 利用モード。 */
  mode: 'store' | 'organize' | 'show' | 'reindex';
  /** 具体イベント種別。 */
  event: 'store.apply' | 'organize.apply' | 'organize.undo' | 'show.open' | 'reindex';
  /** 成否。 */
  ok: boolean;
  /** store: 生成ファイル数 / organize: 適用 proposal 数 / reindex: 差分件数。 */
  count?: number;
  /** vault 相対パス。最大 100 件(超過は切詰め + `truncated:true`)。 */
  paths?: string[];
  /** 関与カテゴリ(`categories[0]` の値)。 */
  categories?: string[];
  /** store: 全 content の合計文字数(概算)。本文そのものは残さない。 */
  approxChars?: number;
  /** organize: 適用した提案種別の内訳。 */
  proposalKinds?: string[];
  /** organize: snapshot ID。 */
  snapshot?: string;
  /** 処理時間(ms)。 */
  durationMs?: number;
  /** `ok:false` のときの失敗内容。 */
  err?: { code: string; message: string };
  /** `paths` を 100 件で切り詰めた場合 true。 */
  truncated?: boolean;
}

/** ダッシュボード集計値(設計 §10-4)。 */
export interface UsageStats {
  /** 集計対象レコードの ts 範囲。レコードが無ければ両方 ''。 */
  range: { from: string; to: string };
  totals: {
    store: number;
    organize: number;
    show: number;
    notesCreated: number;
    notesDeleted: number;
  };
  /** 保存件数推移(日別・昇順)。 */
  storeCountByDay: { date: string; count: number }[];
  /**
   * カテゴリ別分布(件数降順)。
   * 設計 §10-4: 本来は現在の `knowledge/` 実走査(`listNotes`)が主で、ログは補完。
   * `aggregateUsage` はレコードのみを入力とする純関数のため、ここではログ由来の
   * 近似値(store 系レコードの `categories` 出現数)を返す。`knowledge/` 実測との
   * マージは `server/routes/dashboard.ts` 側が行う。
   */
  notesByCategory: { category: string; count: number }[];
  /** モード別回数(月別・昇順)。 */
  modeCountByMonth: { month: string; store: number; organize: number; show: number }[];
  /** 最終利用日時(モード別、無ければ null)。 */
  lastUsedAt: { store: string | null; organize: string | null; show: string | null };
  /**
   * 読み取り時にスキップした壊れ行数。`aggregateUsage` はレコードのみを入力とするため
   * 常に 0。呼び出し側が `readUsage().skipped` を代入する。
   */
  skippedLogLines: number;
}

/** `usage_log.jsonl` の絶対パス。 */
function usageLogPath(projectRoot: string): string {
  return mnemothecaPaths(projectRoot).usageLogJsonl;
}

/** ファイル退避などに使うタイムスタンプ(`config.json.bak-<ts>` と同じ形式)。 */
function retireStamp(): string {
  return String(Date.now());
}

// プロセス内の追記を直列化する mutex。プロセス間ロック(`withLock`)は残り 1 本ずつしか
// 競合しなくなるため、多数の並行 `appendUsage` でもロック取得失敗で行を取りこぼさない。
let appendChain: Promise<void> = Promise.resolve();

/**
 * 1 レコードを追記する(設計 §8-I)。
 *
 * - プロセス内は mutex で直列化し、さらに `withLock(projectRoot, 'usage-log')`(プロセス間)
 *   を取ってから `fs.appendFile`。
 * - 親ディレクトリは `mkdir -p`。
 * - **書き込み失敗(ロック取得失敗・IO エラー等)は握りつぶす**(`console.error` のみ)。
 *   履歴記録は副次的であり、上位処理(store / organize / reindex)を失敗させない。
 */
export async function appendUsage(
  projectRoot: string,
  rec: Omit<UsageRecord, 'v'>,
): Promise<void> {
  const record: UsageRecord = { v: 1, ...rec };
  const line = `${JSON.stringify(record)}\n`;
  const target = usageLogPath(projectRoot);

  const run = appendChain.then(async () => {
    try {
      await withLock(projectRoot, 'usage-log', async () => {
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await fs.promises.appendFile(target, line, 'utf8');
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(`[usage-log] 追記に失敗しました(処理は継続します): ${message}`);
    }
  });
  // チェーンは常に fulfilled で継続させる(1 件の失敗が後続をブロックしない)。
  appendChain = run.catch(() => undefined);
  return run;
}

/**
 * `usage_log.jsonl` を 1 行ずつ読む(設計 §8-I)。
 *
 * - 各行を `JSON.parse`。失敗行・オブジェクトでない行は `skipped++` でスキップ。
 * - ファイルが存在しなければ `{ records: [], skipped: 0 }`。
 * - ファイルはあるが読めない(EISDIR / EACCES 等)= **全損** → `usage_log.jsonl.corrupt-<ts>`
 *   にリネーム退避し、空ログとして `{ records: [], skipped: 0 }` を返す。
 */
export async function readUsage(
  projectRoot: string,
): Promise<{ records: UsageRecord[]; skipped: number }> {
  const target = usageLogPath(projectRoot);

  let raw: string;
  try {
    raw = await fs.promises.readFile(target, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { records: [], skipped: 0 };
    }
    await retireCorruptLog(target);
    return { records: [], skipped: 0 };
  }

  const records: UsageRecord[] = [];
  let skipped = 0;

  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (line === '') {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        records.push(parsed as UsageRecord);
      } else {
        skipped += 1;
      }
    } catch {
      skipped += 1;
    }
  }

  return { records, skipped };
}

/** 全損ログを `usage_log.jsonl.corrupt-<ts>` に退避する(失敗しても投げない)。 */
async function retireCorruptLog(target: string): Promise<void> {
  try {
    await fs.promises.rename(target, `${target}.corrupt-${retireStamp()}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`[usage-log] 破損ログの退避に失敗しました: ${message}`);
  }
}

/**
 * 末尾の途中破損行を切り詰める(設計 §8-I)。サーバー起動時(boot.ts)と `mnemo doctor` で実行。
 *
 * - ファイルが無い / 空 / 末尾が `'\n'` で終わっている → 何もしない(`{ trimmed: false }`)。
 * - 末尾が改行で終わっていない → 最後の完全な改行以降(= 書き込み途中でクラッシュした
 *   不完全行)を `truncate` で切り捨てる(`{ trimmed: true }`)。
 * - ファイル全体が改行を 1 つも含まない不完全行 → 全体を切り捨てる(空ファイル化)。
 */
export async function repairUsageTail(projectRoot: string): Promise<{ trimmed: boolean }> {
  const target = usageLogPath(projectRoot);

  let raw: string;
  try {
    raw = await fs.promises.readFile(target, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { trimmed: false };
    }
    throw err;
  }

  if (raw === '' || raw.endsWith('\n')) {
    return { trimmed: false };
  }

  const lastNewline = raw.lastIndexOf('\n');
  const keepBytes = lastNewline === -1 ? 0 : Buffer.byteLength(raw.slice(0, lastNewline + 1), 'utf8');
  await fs.promises.truncate(target, keepBytes);
  return { trimmed: true };
}

const EMPTY_STATS: UsageStats = {
  range: { from: '', to: '' },
  totals: { store: 0, organize: 0, show: 0, notesCreated: 0, notesDeleted: 0 },
  storeCountByDay: [],
  notesByCategory: [],
  modeCountByMonth: [],
  lastUsedAt: { store: null, organize: null, show: null },
  skippedLogLines: 0,
};

/** organize.apply の proposalKinds のうち「ノート削除を伴う」種別(設計 §8-K/§8-N の命名)。 */
function isDeletingKind(kind: string): boolean {
  return kind.startsWith('merge') || kind.startsWith('delete');
}

/**
 * レコード配列からダッシュボード集計値を計算する(設計 §10-4)。
 *
 * レコードのみを入力とする純関数。空入力 → 全 0(設計 §13-6)。
 * `notesByCategory` はログ由来の近似(`knowledge/` 実測とのマージは dashboard ルート側)。
 * `skippedLogLines` は常に 0(呼び出し側が `readUsage().skipped` を代入する)。
 *
 * 注: 設計の API 表記は `aggregateUsage(records)`。タスク指示の `aggregateUsage(projectRoot)`
 * とは異なるが、設計書(§8-I コードブロック / §8 3 列表 / §13-6「空入力」)を正とした。
 */
export async function aggregateUsage(records: UsageRecord[]): Promise<UsageStats> {
  if (records.length === 0) {
    return structuredClone(EMPTY_STATS);
  }

  const sorted = [...records].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;

  const totals = { store: 0, organize: 0, show: 0, notesCreated: 0, notesDeleted: 0 };
  const storeByDay = new Map<string, number>();
  const byCategory = new Map<string, number>();
  const byMonth = new Map<string, { store: number; organize: number; show: number }>();
  const lastUsedAt: { store: string | null; organize: string | null; show: string | null } = {
    store: null,
    organize: null,
    show: null,
  };

  for (const rec of sorted) {
    const ts = typeof rec.ts === 'string' ? rec.ts : '';
    const day = ts.slice(0, 10);
    const month = ts.slice(0, 7);

    // --- モード別回数 / 最終利用日時 ---
    if (rec.mode === 'store' || rec.mode === 'organize' || rec.mode === 'show') {
      totals[rec.mode] += 1;
      lastUsedAt[rec.mode] = ts || lastUsedAt[rec.mode];
      if (month !== '') {
        const bucket = byMonth.get(month) ?? { store: 0, organize: 0, show: 0 };
        bucket[rec.mode] += 1;
        byMonth.set(month, bucket);
      }
    }

    // --- 保存件数推移 / 作成ノート数 ---
    if (rec.event === 'store.apply' && rec.ok) {
      const n = typeof rec.count === 'number' && rec.count >= 0 ? rec.count : 1;
      totals.notesCreated += n;
      if (day !== '') {
        storeByDay.set(day, (storeByDay.get(day) ?? 0) + n);
      }
      for (const cat of rec.categories ?? []) {
        if (typeof cat === 'string' && cat !== '') {
          byCategory.set(cat, (byCategory.get(cat) ?? 0) + 1);
        }
      }
    }

    // --- 削除ノート数(organize.apply の merge/delete 系 proposalKinds)---
    // 設計 §10-4 は notesDeleted の算出方法を明示していないため、proposalKinds から近似する。
    if (rec.event === 'organize.apply' && rec.ok) {
      for (const kind of rec.proposalKinds ?? []) {
        if (typeof kind === 'string' && isDeletingKind(kind)) {
          totals.notesDeleted += 1;
        }
      }
    }
  }

  const storeCountByDay = [...storeByDay.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  const notesByCategory = [...byCategory.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || (a.category < b.category ? -1 : 1));

  const modeCountByMonth = [...byMonth.entries()]
    .map(([month, v]) => ({ month, ...v }))
    .sort((a, b) => (a.month < b.month ? -1 : 1));

  return {
    range: { from: first.ts ?? '', to: last.ts ?? '' },
    totals,
    storeCountByDay,
    notesByCategory,
    modeCountByMonth,
    lastUsedAt,
    skippedLogLines: 0,
  };
}
