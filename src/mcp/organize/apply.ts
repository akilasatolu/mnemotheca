// src/mcp/organize/apply.ts — organize apply フェーズの FileOp 実行(設計書 §8-N apply step 6c)。
//
// このモジュールは「確定した `FileOp[]` を vault へ順に適用し、実行内容のサマリーと
// スナップショット finalize 用の差分(`created` / `deletions`)を返す」ことだけに責務を限定する。
// スナップショット作成・`applying` フラグ・ロールバック・ロック・再インデックス・usage は
// 呼び出し側(`src/mcp/tools/organize.ts` の `organizeApplyModule`)の責務。
//
// FileOp 実行順序(設計書 §8-N): mkdir → move → rewrite-frontmatter
// → merge-into → delete → rmdir。呼び出し側から渡された順序に依らずこの順へ整列してから実行する。
// 実行順序の担保はここ(apply)の責務。
//
// 注意点:
//   - `merge-into` は本文統合のみ(sources を unlink しない)。実削除は後続の `delete` op。
//   - `rewrite-frontmatter` は `frontmatterPatch` が無くても `normalizeFrontmatter` で
//     `categories` スカラー化 / `created > updated` を自前で正規化する。

import fs from 'node:fs';
import path from 'node:path';

import { MnemoError } from '../../core/errors.js';
import type { Frontmatter } from '../../core/frontmatter.js';
import { normalizeFrontmatter } from '../../core/frontmatter.js';
import { readNote, writeNote } from '../../core/note.js';
import { vaultPaths } from '../../core/paths.js';
import { scanPii } from '../../core/pii.js';
import type { FileOp } from './preview.js';

/** apply 実行結果のサマリー(設計書 §8-N `OrganizeApplyResult.summary`)。 */
export interface OrganizeApplySummary {
  dirsCreated: string[];
  dirsRemoved: string[];
  filesMoved: Array<{ from: string; to: string }>;
  filesMerged: Array<{ sources: string[]; into: string }>;
  filesDeleted: string[];
  frontmatterFixed: string[];
}

/** `executeFileOps` の戻り値。`created` / `deletions` は `finalizeSnapshotManifest` へ渡す。 */
export interface ExecuteFileOpsResult {
  summary: OrganizeApplySummary;
  /** apply で新規作成されたファイルの vault 相対パス(snapshot manifest の `created` へ)。 */
  created: string[];
  /** apply で削除された元ファイルの vault 相対パス(snapshot manifest の `deletions` へ)。 */
  deletions: string[];
}

const OP_ORDER: Record<FileOp['op'], number> = {
  mkdir: 0,
  move: 1,
  'rewrite-frontmatter': 2,
  'merge-into': 3,
  delete: 4,
  rmdir: 5,
};

/** vault 相対 POSIX パス → 絶対パス。 */
function absOf(vaultRoot: string, relPath: string): string {
  return path.join(vaultRoot, ...relPath.split('/').filter((s) => s !== '' && s !== '.'));
}

/** tags の和集合(初出順を保持)。 */
function unionTags(a: string[], b: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of [...a, ...b]) {
    if (typeof t === 'string' && t !== '' && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/** merge-into で新たに書く本文に PII(block 相当)が含まれていたら中断する(設計書 §8-N / §7)。 */
function assertNoPii(relPath: string, body: string): void {
  const hits = scanPii(body).blocks;
  if (hits.length > 0) {
    throw new MnemoError('PII_BLOCKED', `統合後の本文 ${relPath} に機密情報が含まれています`, {
      hits: hits.map((h) => ({ pattern: h.pattern, masked: h.masked, relPath })),
    });
  }
}

/**
 * 確定した `FileOp[]` を vault へ順に適用する(設計書 §8-N apply step 6c)。
 *
 * 途中の失敗はそのまま throw する(呼び出し側が `restoreSnapshot` で全戻しする)。
 * `now` は `merge-into` の `updated` 更新に使う(テスト用に注入可能)。
 */
export async function executeFileOps(
  projectRoot: string,
  ops: FileOp[],
  now: number = Date.now(),
): Promise<ExecuteFileOpsResult> {
  const vaultRoot = vaultPaths(projectRoot).root;
  const nowIso = new Date(now).toISOString();

  const summary: OrganizeApplySummary = {
    dirsCreated: [],
    dirsRemoved: [],
    filesMoved: [],
    filesMerged: [],
    filesDeleted: [],
    frontmatterFixed: [],
  };
  const created: string[] = [];
  const deletions: string[] = [];

  // merge-into は into ごとにまとめる(サマリー整形・本文の逐次追記のため)。
  const mergeGroups = new Map<string, string[]>();

  const ordered = ops
    .map((op, i) => ({ op, i }))
    .sort((a, b) => OP_ORDER[a.op.op] - OP_ORDER[b.op.op] || a.i - b.i)
    .map((x) => x.op);

  for (const op of ordered) {
    switch (op.op) {
      case 'mkdir': {
        if (op.to === undefined) break;
        await fs.promises.mkdir(absOf(vaultRoot, op.to), { recursive: true });
        if (!summary.dirsCreated.includes(op.to)) summary.dirsCreated.push(op.to);
        break;
      }

      case 'move': {
        if (op.from === undefined || op.to === undefined) break;
        const fromAbs = absOf(vaultRoot, op.from);
        const toAbs = absOf(vaultRoot, op.to);
        const { fm, body } = await readNote(fromAbs);
        const nextFm: Frontmatter = { ...fm, ...(op.frontmatterPatch ?? {}) };
        await writeNote(toAbs, nextFm, body);
        if (path.resolve(fromAbs) !== path.resolve(toAbs)) {
          await fs.promises.unlink(fromAbs);
          if (!deletions.includes(op.from)) deletions.push(op.from);
        }
        if (!created.includes(op.to)) created.push(op.to);
        summary.filesMoved.push({ from: op.from, to: op.to });
        break;
      }

      case 'rewrite-frontmatter': {
        const rel = op.from ?? op.to;
        if (rel === undefined) break;
        const abs = absOf(vaultRoot, rel);
        const { fm, body } = await readNote(abs);
        // patch が無い場合でも(categories-scalar / created-after-updated の正規化は)
        // ここで normalizeFrontmatter により自前で行う。
        const normalized = normalizeFrontmatter(fm);
        const nextFm: Frontmatter = { ...normalized, ...(op.frontmatterPatch ?? {}) };
        await writeNote(abs, nextFm, body);
        if (!summary.frontmatterFixed.includes(rel)) summary.frontmatterFixed.push(rel);
        break;
      }

      case 'merge-into': {
        if (op.from === undefined || op.to === undefined) break;
        const intoAbs = absOf(vaultRoot, op.to);
        const fromAbs = absOf(vaultRoot, op.from);
        const into = await readNote(intoAbs);
        const src = await readNote(fromAbs);
        const mergedBody = `${into.body}\n\n---\n\n${src.body}`;
        assertNoPii(op.to, mergedBody);
        const nextFm: Frontmatter = {
          ...into.fm,
          tags: unionTags(into.fm.tags ?? [], src.fm.tags ?? []),
          updated: nowIso,
        };
        await writeNote(intoAbs, nextFm, mergedBody);
        const group = mergeGroups.get(op.to) ?? [];
        group.push(op.from);
        mergeGroups.set(op.to, group);
        break;
      }

      case 'delete': {
        if (op.from === undefined) break;
        const abs = absOf(vaultRoot, op.from);
        try {
          await fs.promises.unlink(abs);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
        if (!summary.filesDeleted.includes(op.from)) summary.filesDeleted.push(op.from);
        if (!deletions.includes(op.from)) deletions.push(op.from);
        break;
      }

      case 'rmdir': {
        if (op.from === undefined) break;
        try {
          await fs.promises.rmdir(absOf(vaultRoot, op.from));
          if (!summary.dirsRemoved.includes(op.from)) summary.dirsRemoved.push(op.from);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT' && code !== 'ENOTEMPTY') throw err;
        }
        break;
      }

      default:
        break;
    }
  }

  for (const [into, sources] of mergeGroups) {
    summary.filesMerged.push({ sources, into });
  }

  return { summary, created, deletions };
}

/** 選択 FileOp 列から影響を受ける vault 相対パス(`.md`)を重複排除して返す(snapshot 対象)。 */
export function affectedRelPaths(ops: FileOp[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const op of ops) {
    for (const p of [op.from, op.to]) {
      if (p !== undefined && p.endsWith('.md') && !seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
  }
  return out;
}

/**
 * ロックスコープを決定する(設計書 §8-N apply step 5)。
 * - `merge-category` 提案を含む or 触るトップレベルカテゴリが 2 つ以上 → `'vault'`
 * - 単一カテゴリ内で完結 → `category:<seg>`
 * - カテゴリが特定できない(ops 無し等)→ `'vault'`
 */
export function decideLockScope(
  ops: FileOp[],
  proposalKinds: string[],
): 'vault' | `category:${string}` {
  if (proposalKinds.includes('merge-category') || proposalKinds.includes('rename-category')) {
    return 'vault';
  }
  const segs = new Set<string>();
  for (const op of ops) {
    for (const p of [op.from, op.to]) {
      if (p === undefined) continue;
      const parts = p.split('/').filter((s) => s !== '');
      if (parts[0] === 'knowledge' && parts.length >= 2 && parts[1] !== undefined) {
        segs.add(parts[1]);
      }
    }
  }
  if (segs.size !== 1) return 'vault';
  return `category:${[...segs][0] as string}`;
}
