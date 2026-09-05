// src/mcp/tools/list.ts — 補助 tool `mnemo_list_categories` / `mnemo_get_vault_info`(設計 §8-P)。
//
// どちらも **読み取り専用**(FS 書き込みを一切行わない)。store フロー(§3-1 手順 2)が
// `mnemo_list_categories` に依存する。
//
// - `mnemo_list_categories`: `knowledge/` 配下の実ディレクトリ構造を正として
//   カテゴリ一覧 + ノート件数を返す。壊れたノート(`listNotes` の errors[])は
//   noteCount / totalNotes から除外するが、走査自体は落とさない。
// - `mnemo_get_vault_info`: projectRoot / vault パス・件数・稼働サーバー・最終利用時刻・
//   MCP サーバーキーを返す。`serverRunning` 判定は `detectRunningServer`(§8-O。
//   `show.ts` と共有)を使う。
//
// 登録形(設計 §8-P / §8-L の突き合わせ):
//   1 モジュール = 1 tool の原則に従い 2 つの `ToolModule` を **named export**
//   (`listCategoriesModule` / `vaultInfoModule`)し、加えて registry がどちらの規約でも
//   拾えるよう **default export = その 2 つの配列**にする。

import fs from 'node:fs';
import path from 'node:path';

import matter from 'gray-matter';
import { z } from 'zod';

import { buildMcpSnippet } from '../../core/mcp-snippet.js';
import { listNotes } from '../../core/note.js';
import { vaultPaths } from '../../core/paths.js';
import { readUsage } from '../../core/usage-log.js';
import { detectRunningServer } from '../reindex-client.js';
import type { CallToolResult, ToolContext, ToolModule } from './types.js';

// ───────────────────────── 共通: カテゴリ集約 ─────────────────────────

interface CategoryAggregate {
  /** `knowledge/` 相対の POSIX カテゴリ経路(例: `architecture` / `tech/architecture`)。 */
  categories: { path: string; title: string; noteCount: number }[];
  uncategorizedCount: number;
  /** 正常に読めたノートの総数(壊れノートは含めない)。 */
  totalNotes: number;
}

/** ノートの vault 相対パス(`knowledge/<...>/<slug>.md`)から `knowledge/` 相対のカテゴリ経路を得る。 */
function categoryPathOf(relPath: string): string {
  const parts = relPath.split('/');
  // parts[0] === 'knowledge'、最後はファイル名。
  const segs = parts.slice(1, -1);
  return segs.join('/');
}

/** `vault/categories/<catPath>.md` の frontmatter `title`。無ければセグメント名にフォールバック。 */
function resolveCategoryTitle(categoriesDir: string, catPath: string): string {
  const segs = catPath.split('/');
  const fallback = segs[segs.length - 1] ?? catPath;
  const file = `${path.join(categoriesDir, ...segs)}.md`;
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
  try {
    const t = (matter(raw).data as Record<string, unknown>)['title'];
    return typeof t === 'string' && t.trim() !== '' ? t : fallback;
  } catch {
    return fallback;
  }
}

async function aggregateCategories(projectRoot: string): Promise<CategoryAggregate> {
  const { categoriesDir } = vaultPaths(projectRoot);
  const { notes } = await listNotes(projectRoot);

  const counts = new Map<string, number>();
  let uncategorizedCount = 0;

  for (const note of notes) {
    const catPath = categoryPathOf(note.relPath);
    if (catPath === '' || catPath === '_uncategorized') {
      uncategorizedCount += 1;
      continue;
    }
    counts.set(catPath, (counts.get(catPath) ?? 0) + 1);
  }

  const categories = [...counts.entries()]
    .map(([catPath, noteCount]) => ({
      path: catPath,
      title: resolveCategoryTitle(categoriesDir, catPath),
      noteCount,
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return { categories, uncategorizedCount, totalNotes: notes.length };
}

// ───────────────────────── mnemo_list_categories ─────────────────────────

const listCategoriesInput = z.object({});

const LIST_CATEGORIES_DESCRIPTION =
  '既存のカテゴリ一覧と各カテゴリのノート件数、未分類(_uncategorized)件数、総ノート数を返す。' +
  'mnemo_store で保存する前に、既存カテゴリ名を確認するために必ず呼ぶ。この tool はファイルを変更しない。';

async function listCategoriesHandler(_args: unknown, ctx: ToolContext): Promise<CallToolResult> {
  const agg = await aggregateCategories(ctx.projectRoot);

  const lines =
    agg.categories.length === 0
      ? ['(カテゴリはまだありません)']
      : agg.categories.map((c) => `- ${c.path} — ${c.title}(${c.noteCount} 件)`);
  const text =
    `カテゴリ ${agg.categories.length} 件 / 未分類 ${agg.uncategorizedCount} 件 / 総ノート ${agg.totalNotes} 件\n` +
    lines.join('\n');

  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: {
      categories: agg.categories,
      uncategorizedCount: agg.uncategorizedCount,
      totalNotes: agg.totalNotes,
    },
  };
}

export const listCategoriesModule: ToolModule = {
  name: 'mnemo_list_categories',
  config: {
    title: 'カテゴリ一覧とノート件数',
    description: LIST_CATEGORIES_DESCRIPTION,
    inputSchema: listCategoriesInput,
  },
  handler: listCategoriesHandler,
};

// ───────────────────────── mnemo_get_vault_info ─────────────────────────

const vaultInfoInput = z.object({});

const VAULT_INFO_DESCRIPTION =
  'この Mnemotheca プロジェクトの projectRoot・vault パス・ノート/カテゴリ件数・' +
  'HTTP サーバーの稼働状況・最終保存/整理時刻・MCP サーバーキーを返す。この tool はファイルを変更しない。';

/** `usage_log.jsonl` から指定 mode の最新レコードの ts を返す(履歴なし → null)。 */
function latestTs(records: { mode?: string; ts?: string }[], mode: string): string | null {
  let latest: string | null = null;
  for (const rec of records) {
    if (rec.mode !== mode || typeof rec.ts !== 'string' || rec.ts === '') continue;
    if (latest === null || rec.ts > latest) latest = rec.ts;
  }
  return latest;
}

async function vaultInfoHandler(_args: unknown, ctx: ToolContext): Promise<CallToolResult> {
  const { projectRoot } = ctx;
  const vaultPath = vaultPaths(projectRoot).root;

  const agg = await aggregateCategories(projectRoot);
  const detection = await detectRunningServer(projectRoot);
  const { records } = await readUsage(projectRoot);
  const { serverKey } = buildMcpSnippet(projectRoot);

  const info = {
    projectRoot,
    vaultPath,
    noteCount: agg.totalNotes,
    categoryCount: agg.categories.length,
    lastStoreAt: latestTs(records, 'store'),
    lastOrganizeAt: latestTs(records, 'organize'),
    serverRunning: detection.running,
    serverUrl: detection.url,
    mcpServerKey: serverKey,
  };

  const text =
    `projectRoot: ${info.projectRoot}\n` +
    `vault: ${info.vaultPath}\n` +
    `ノート ${info.noteCount} 件 / カテゴリ ${info.categoryCount} 件\n` +
    `サーバー: ${info.serverRunning ? `稼働中(${info.serverUrl})` : '停止中'}\n` +
    `最終保存: ${info.lastStoreAt ?? 'なし'} / 最終整理: ${info.lastOrganizeAt ?? 'なし'}\n` +
    `MCP サーバーキー: ${info.mcpServerKey}`;

  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: info,
  };
}

export const vaultInfoModule: ToolModule = {
  name: 'mnemo_get_vault_info',
  config: {
    title: 'vault の基本情報',
    description: VAULT_INFO_DESCRIPTION,
    inputSchema: vaultInfoInput,
  },
  handler: vaultInfoHandler,
};

// ───────────────────────── default export(registry 用)─────────────────────────

const listModules: ToolModule[] = [listCategoriesModule, vaultInfoModule];

export default listModules;
