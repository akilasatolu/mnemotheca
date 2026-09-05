// src/cli/commands/status.ts — `mnemo status [--json]`(設計 §9-1 / §13-14)。
//
// 表示項目:
//   - サーバー稼働状態(pid / port / url。`detectRunningServer` = run.json + pid + healthz 一致)
//   - projectRoot / vault パス
//   - ノート件数(`listNotes`)
//   - インデックス鮮度(`meta.json` の `builtAt` と、現在の knowledge/ との差分件数)
//   - スナップショット数(`listSnapshots`)
//   - 直近利用日(usage_log の最新 `ts`)
//
// I/O ヘルパはすべて `StatusDeps` で注入できる(既定は本物)。実サーバーには接続しない
// (`detectRunningServer` を注入で差し替える)。

import fs from 'node:fs';

import { MnemoError } from '../../core/errors.js';
import { mnemothecaPaths, vaultPaths } from '../../core/paths.js';
import { listNotes as realListNotes } from '../../core/note.js';
import type { NoteError, NoteRef } from '../../core/note.js';
import { listSnapshots as realListSnapshots } from '../../core/snapshot.js';
import type { SnapshotInfo } from '../../core/snapshot.js';
import { readUsage as realReadUsage } from '../../core/usage-log.js';
import type { UsageRecord } from '../../core/usage-log.js';
import { detectRunningServer as realDetectRunningServer } from '../../mcp/reindex-client.js';
import type { ServerDetection } from '../../mcp/reindex-client.js';
import type { CliCommandContext } from '../index.js';
import * as ui from '../ui.js';

/** `meta.json`(`core/search.ts` の `IndexMeta`)の必要部分だけ。 */
interface MetaShape {
  builtAt?: unknown;
  docs?: Record<string, { id?: unknown; mtimeMs?: unknown } | undefined>;
}

/** `mnemo status` の依存注入ポイント。 */
export interface StatusDeps {
  detectRunningServer: (projectRoot: string) => Promise<ServerDetection>;
  listNotes: (projectRoot: string) => Promise<{ notes: NoteRef[]; errors: NoteError[] }>;
  listSnapshots: (projectRoot: string) => Promise<SnapshotInfo[]>;
  readUsage: (
    projectRoot: string,
  ) => Promise<{ records: UsageRecord[]; skipped: number }>;
  /** `meta.json` を読む。無い / 壊れていれば null。 */
  readMeta: (projectRoot: string) => Promise<MetaShape | null>;
  /** 1 行出力(既定 stdout)。 */
  write: (line: string) => void;
}

async function defaultReadMeta(projectRoot: string): Promise<MetaShape | null> {
  const { metaJson } = mnemothecaPaths(projectRoot);
  let raw: string;
  try {
    raw = await fs.promises.readFile(metaJson, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as MetaShape;
    }
  } catch {
    /* fallthrough */
  }
  return null;
}

function resolveDeps(over?: Partial<StatusDeps>): StatusDeps {
  return {
    detectRunningServer: (projectRoot: string) => realDetectRunningServer(projectRoot),
    listNotes: realListNotes,
    listSnapshots: realListSnapshots,
    readUsage: realReadUsage,
    readMeta: defaultReadMeta,
    write: (line: string) => process.stdout.write(`${line}\n`),
    ...over,
  };
}

/** meta.json と現在のノート群を突き合わせ「インデックス未反映」件数を数える。 */
async function countStale(notes: NoteRef[], meta: MetaShape | null): Promise<number> {
  if (meta === null) {
    return notes.length;
  }
  const docs = meta.docs ?? {};
  const known = new Set(Object.keys(docs));
  let stale = 0;
  for (const note of notes) {
    const rec = docs[note.relPath];
    if (rec === undefined) {
      stale += 1;
      continue;
    }
    known.delete(note.relPath);
    let mtimeMs: number | null = null;
    try {
      mtimeMs = (await fs.promises.stat(note.absPath)).mtimeMs;
    } catch {
      stale += 1;
      continue;
    }
    const recorded = typeof rec.mtimeMs === 'number' ? rec.mtimeMs : NaN;
    if (Math.round(recorded) !== Math.round(mtimeMs)) {
      stale += 1;
    }
  }
  // meta にはあるが現存しない = 削除された分。
  stale += known.size;
  return stale;
}

interface StatusReport {
  running: boolean;
  server: { pid: number; port: number; url: string } | null;
  projectRoot: string;
  vaultPath: string;
  noteCount: number;
  index: { builtAt: string | null; staleCount: number };
  snapshotCount: number;
  lastUsedAt: string | null;
}

export async function run(
  ctx: CliCommandContext,
  over?: Partial<StatusDeps>,
): Promise<void> {
  const deps = resolveDeps(over);
  const projectRoot = ctx.projectRoot;
  if (projectRoot === undefined) {
    throw new MnemoError('NOT_INITIALIZED', 'projectRoot を解決できませんでした');
  }

  const [detection, notesResult, snapshots, usage, meta] = await Promise.all([
    deps.detectRunningServer(projectRoot),
    deps.listNotes(projectRoot),
    deps.listSnapshots(projectRoot),
    deps.readUsage(projectRoot),
    deps.readMeta(projectRoot),
  ]);

  const running = detection.running && detection.run !== null;
  const server =
    running && detection.run !== null
      ? {
          pid: detection.run.pid,
          port: detection.run.port,
          url: detection.url ?? `http://127.0.0.1:${detection.run.port}`,
        }
      : null;

  const noteCount = notesResult.notes.length;
  const staleCount = await countStale(notesResult.notes, meta);
  const builtAt =
    meta !== null && typeof meta.builtAt === 'string' ? meta.builtAt : null;

  let lastUsedAt: string | null = null;
  for (const rec of usage.records) {
    if (typeof rec.ts === 'string' && (lastUsedAt === null || rec.ts > lastUsedAt)) {
      lastUsedAt = rec.ts;
    }
  }

  const report: StatusReport = {
    running,
    server,
    projectRoot,
    vaultPath: vaultPaths(projectRoot).root,
    noteCount,
    index: { builtAt, staleCount },
    snapshotCount: snapshots.length,
    lastUsedAt,
  };

  if (ctx.global.json) {
    deps.write(JSON.stringify(report));
    return;
  }

  const lines: string[] = [];
  if (server !== null) {
    lines.push(`${ui.bold('状態')}: ${ui.success('稼働中')} (pid ${server.pid}, port ${server.port})`);
    lines.push(`URL: ${server.url}`);
  } else {
    lines.push(`${ui.bold('状態')}: ${ui.dim('停止中')}`);
  }
  lines.push(`projectRoot: ${report.projectRoot}`);
  lines.push(`vault: ${report.vaultPath}`);
  lines.push(`ノート件数: ${report.noteCount}`);
  if (builtAt === null) {
    lines.push('インデックス: 未構築');
  } else {
    lines.push(
      `インデックス: ${builtAt}` +
        (staleCount > 0 ? ` (${staleCount} 件が未反映)` : ' (最新)'),
    );
  }
  lines.push(`スナップショット: ${report.snapshotCount} 件`);
  lines.push(`直近利用: ${lastUsedAt ?? 'なし'}`);
  deps.write(lines.join('\n'));
}
