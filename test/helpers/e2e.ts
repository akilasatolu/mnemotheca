// test/helpers/e2e.ts — 設計 §13-16「結合(E2E 相当)」の共通ヘルパ。
//
// 実プロセス spawn / 実ブラウザ / 実ネットワーク / 実 FS 監視は使わない。
//   - MCP  : `TOOL_MODULES`(registry.ts)のハンドラを直接呼ぶ。
//   - HTTP : `createApp(appDeps, mountApiRoutes(deps))` を `app.request()` で叩く。
//
// 既存の `test/helpers/project.ts`(`makeProject` / `simulateCloneState`)・
// `test/helpers/runtime.ts`(`withRuntimeDir`)には手を入れず、ここで束ねるだけ。

import fs from 'node:fs';
import path from 'node:path';

import type { Hono } from 'hono';

import { buildIndex, type IndexHandle } from '../../src/core/search.js';
import { runtimePaths } from '../../src/core/paths.js';
import { TOOL_MODULES } from '../../src/mcp/tools/registry.js';
import type { CallToolResult, ToolContext, ToolModule } from '../../src/mcp/tools/types.js';
import { createApp } from '../../src/server/app.js';
import {
  mountApiRoutes,
  type MountApiRoutesDeps,
  type OrganizeRecoveryPending,
} from '../../src/server/mount.js';
import { makeProject } from './project.js';

export const E2E_TOKEN = 'e2e-test-token-abc';
export const authHeader = { Authorization: `Bearer ${E2E_TOKEN}` } as const;

/** 生成した projectRoot を追跡し、`cleanupRoots()` でまとめて削除する。 */
const trackedRoots: string[] = [];

export async function makeTrackedProject(): Promise<string> {
  const root = await makeProject();
  trackedRoots.push(root);
  return root;
}

/** 追跡中の projectRoot と、それに対応するランタイムスロットを削除する(afterEach で呼ぶ)。 */
export function cleanupRoots(): void {
  while (trackedRoots.length > 0) {
    const d = trackedRoots.pop();
    if (d === undefined) continue;
    try {
      fs.rmSync(runtimePaths(d).dir, { recursive: true, force: true });
    } catch {
      /* ランタイム領域は MNEMO_RUNTIME_DIR 差し替え時に別で掃除される */
    }
    fs.rmSync(d, { recursive: true, force: true });
  }
}

/** 追跡対象に後から任意ディレクトリ(cp 先など)を足す。 */
export function trackRoot(root: string): string {
  trackedRoots.push(root);
  return root;
}

// ───────────────────────── MCP tool ハンドラ直呼び ─────────────────────────

export function toolCtx(projectRoot: string): ToolContext {
  return { projectRoot };
}

export function toolModule(name: string): ToolModule {
  const mod = TOOL_MODULES.find((m) => m.name === name);
  if (mod === undefined) {
    throw new Error(`tool module not found: ${name}`);
  }
  return mod;
}

export function callTool(
  name: string,
  args: Record<string, unknown>,
  projectRoot: string,
): Promise<CallToolResult> {
  return toolModule(name).handler(args, toolCtx(projectRoot));
}

/** `structuredContent` を型付きで取り出す(noUncheckedIndexedAccess 下の取り回し用)。 */
export function sc<T = Record<string, unknown>>(res: CallToolResult): T {
  return res.structuredContent as unknown as T;
}

export function firstText(res: CallToolResult): string {
  const c = res.content[0];
  return c && c.type === 'text' ? c.text : '';
}

// ───────────────────────── store の dry-run → apply ─────────────────────────

export interface StoreTopicInput {
  slug: string;
  title: string;
  targetDir: string;
  categories?: string[];
  tags?: string[];
  summary?: string;
  detail?: string;
}

function normalizeTopic(t: StoreTopicInput): Record<string, unknown> {
  return {
    slug: t.slug,
    title: t.title,
    targetDir: t.targetDir,
    categories: t.categories ?? [t.targetDir],
    tags: t.tags ?? ['e2e'],
    summary: t.summary ?? `${t.title} の要約。`,
    detail: t.detail ?? `## 詳細\n\n${t.title} の本文テキスト。\n`,
  };
}

/**
 * §13-16「mcp store(dry-run → apply)→ ファイル生成確認」。
 * 同一プロセス内で dry-run 直後に apply するので誤 apply 保険(notesHash+TTL)を通過する。
 */
export async function storeNotes(
  projectRoot: string,
  topics: StoreTopicInput[],
): Promise<CallToolResult> {
  const notes = topics.map(normalizeTopic);
  const dry = await callTool('mnemo_store', { notes }, projectRoot);
  if (dry.isError) {
    throw new Error(`store dry-run failed: ${firstText(dry)}`);
  }
  return callTool('mnemo_store', { notes, apply: true }, projectRoot);
}

// ───────────────────────── HTTP アプリ組み立て ─────────────────────────

export interface AppOver {
  getIndex?: () => Promise<IndexHandle>;
  getOrganizeRecoveryPending?: () => Promise<OrganizeRecoveryPending | null>;
  watcherIsDown?: () => boolean;
  readIndexMeta?: MountApiRoutesDeps['readIndexMeta'];
  onRebuilt?: (h: IndexHandle) => void;
}

/** `createApp` + `mountApiRoutes` を最小スタブで束ねる。既定の `getIndex` は毎回 `buildIndex`。 */
export function buildApp(projectRoot: string, over: AppOver = {}): Hono {
  const deps: MountApiRoutesDeps = {
    projectRoot,
    vaultPath: path.join(projectRoot, 'vault'),
    port: 7777,
    startedAt: '2026-09-03T00:00:00.000Z',
    version: '9.9.9-e2e',
    token: E2E_TOKEN,
    getIndex: over.getIndex ?? (() => buildIndex(projectRoot)),
    subscribe: () => () => undefined,
    ...(over.onRebuilt ? { onRebuilt: over.onRebuilt } : {}),
    ...(over.readIndexMeta ? { readIndexMeta: over.readIndexMeta } : {}),
    ...(over.getOrganizeRecoveryPending
      ? { getOrganizeRecoveryPending: over.getOrganizeRecoveryPending }
      : {}),
    ...(over.watcherIsDown ? { watcherIsDown: over.watcherIsDown } : {}),
  };
  return createApp(
    {
      projectRoot,
      token: E2E_TOKEN,
      port: 7777,
      startedAt: '2026-09-03T00:00:00.000Z',
      version: '9.9.9-e2e',
    },
    mountApiRoutes(deps),
  );
}

export async function getJson<T>(app: Hono, pathAndQuery: string): Promise<{ status: number; body: T }> {
  const res = await app.request(pathAndQuery, { headers: authHeader });
  return { status: res.status, body: (await res.json()) as T };
}

// ───────────────────────── 壊れノート ─────────────────────────

/** vault に frontmatter 不正な `.md` を 1 つ置く(§13-16「壊れノート混在」)。戻り値は絶対パス。 */
export async function writeBrokenNote(
  projectRoot: string,
  rel = 'knowledge/architecture/broken.md',
): Promise<string> {
  const abs = path.join(projectRoot, 'vault', ...rel.split('/'));
  await fs.promises.mkdir(path.dirname(abs), { recursive: true });
  await fs.promises.writeFile(
    abs,
    '---\nid: [壊れた YAML\ntitle: :::\ncategories: architecture\n---\n\n本文が続く\n',
    'utf8',
  );
  return abs;
}
