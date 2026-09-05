// src/mcp/tools/store.ts — `mnemo_store`(会話内容をトピック分解してナレッジ保存)。設計 §8-M。
//
// dry-run(`apply:false`): `StorePlan`(作成予定パス・新規カテゴリ・衝突解決・PII)を返し、
//   ファイルは一切作成しない。
// apply(`apply:true`): このプロセスで同一 notes の dry-run を 30 分以内に見ていなければ
//   `StorePlan` を返すだけ(誤 apply の保険。§8-M step 2)。見ていれば:
//     checkVault → PII BLOCK 検査 → 不変条件検査 → withLock('knowledge') で
//     resolveCollision → writeNote(原子的・途中失敗で全ロールバック) →
//     regenerateCategories → reindexPaths(差分) → appendUsage → パス一覧を返す。
//
// このモジュールは `ToolModule` を **default export** する(結線は registry.ts)。
// handler は `(args, ctx: ToolContext) => Promise<CallToolResult>`。`ctx.projectRoot` を使う。

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { assertCategoryPathInvariant } from '../../core/category.js';
import { MnemoError } from '../../core/errors.js';
import type { Frontmatter } from '../../core/frontmatter.js';
import { newId } from '../../core/id.js';
import { withLock } from '../../core/lock.js';
import { buildBody, readNote, writeNote } from '../../core/note.js';
import { vaultPaths } from '../../core/paths.js';
import { scanPii } from '../../core/pii.js';
import { resolveCollision } from '../../core/slug.js';
import { regenerateCategories } from '../../core/categories-index.js';
import { appendUsage } from '../../core/usage-log.js';
import { checkVault } from '../../core/vault-check.js';
import { reindexPaths } from '../reindex-client.js';
import { formatStorePlan, formatStoreResult } from '../format.js';
import type { StorePlanLike, StoreResultLike } from '../format.js';
import type { CallToolResult, ToolContext, ToolModule } from './types.js';

// ───────────────────────── inputSchema(Zod v4。設計 §8-M)─────────────────────────

const TopicNote = z.object({
  slug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(80)
    .describe('英字スラッグ。日付プレフィックス禁止。例: aws-mcp-feasibility'),
  title: z.string().min(1).max(200).describe('内容を表す簡潔な日本語タイトル'),
  targetDir: z
    .string()
    .regex(/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$|^_uncategorized$/)
    .describe(
      '保存先カテゴリ。単一セグメントのみ(スラッシュ不可)。' +
        '既存カテゴリ名か、新規カテゴリ名、または _uncategorized。' +
        '多階層化は organize の役割なので store では指定不可。',
    ),
  categories: z
    .array(z.string())
    .min(1)
    .describe(
      'categories[0] は必ず targetDir と同一文字列。' +
        'categories[1..] は補助分類(任意、スラッシュ可)。',
    ),
  tags: z.array(z.string().min(1)).max(20).describe('関連タグ(小文字英字推奨、日本語可)'),
  summary: z.string().min(1).max(500).describe('1〜3 文の要約'),
  detail: z.string().min(1).describe('整理済み本文(Markdown)。## 見出しを含んでよい'),
  references: z.string().optional().describe('出典・参考リンク(任意)'),
  source: z.enum(['claude-desktop', 'claude-code', 'unknown']).optional(),
  collisionStrategy: z
    .enum(['auto-number', 'append-to-existing', 'abort'])
    .default('auto-number')
    .describe('同名 slug が既存の場合の扱い。判断がつかなければ会話でユーザーに確認してから指定'),
});

export const StoreInputSchema = z.object({
  notes: z.array(TopicNote).min(1).max(30),
  apply: z
    .boolean()
    .default(false)
    .describe(
      'false=保存予定の提示のみ(dry-run)。true=実書き込み。' +
        '必ず apply:false で予定を出しユーザー承認を得てから apply:true を送ること。',
    ),
});

/** パース済み 1 ノート(`collisionStrategy` は default 適用済み)。 */
type ParsedTopicNote = z.output<typeof TopicNote>;
type ParsedStoreInput = z.output<typeof StoreInputSchema>;

// ───────────────────────── STORE_DESCRIPTION(設計 §8-M。全文)─────────────────────────

export const STORE_DESCRIPTION =
  'ユーザーが『保存して』『これ覚えておいて』『メモして』『あとで見返せるようにして』等、' +
  '明確に保存を指示したときに呼ぶ。今の会話の内容をトピック単位に分解し(1 トピック = 1 ファイル、' +
  '迷ったら分割)、カテゴリディレクトリ配下に複数の Markdown として保存する。' +
  '**過去に保存済みのファイルの再整理は organize を使う(このツールではない)**。' +
  '呼ぶ前に必ず: (1) mnemo_list_categories で既存カテゴリを確認 ' +
  '(2) 氏名・住所・電話・メール・生年月日・識別番号・パスワード・API キー・トークン等を' +
  '本文から除外(判断に迷えば残さない) ' +
  '(3) apply:false で保存予定を取得しユーザーに提示・承認を得る。承認後に apply:true を送る。';

// ───────────────────────── 誤 apply 保険(notesHash + TTL 30 分の in-process Map)─────────────────────────

/** dry-run を見た notes のハッシュ → 見た時刻(ms)。設計 §8-M step 2。 */
const seenDryRuns = new Map<string, number>();
const DRY_RUN_TTL_MS = 30 * 60 * 1000;

/** 入力 notes の安定ハッシュ(Claude が同一 notes を再送する前提)。 */
function hashNotes(notes: ParsedStoreInput['notes']): string {
  return createHash('sha256').update(JSON.stringify(notes)).digest('hex');
}

/** テスト用: 誤 apply 保険の Map をクリアする。 */
export function __resetStoreDryRunMemory(): void {
  seenDryRuns.clear();
}

// ───────────────────────── 共通ヘルパ ─────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const t = v.trim();
    if (t === '' || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

function toRelPosix(projectRoot: string, absPath: string): string {
  const vaultRoot = vaultPaths(projectRoot).root;
  return path.relative(vaultRoot, absPath).split(path.sep).join('/');
}

/** そのノートが書き込まれるディレクトリ(`knowledge/<targetDir>/`)。 */
function noteDir(projectRoot: string, note: ParsedTopicNote): string {
  return path.join(vaultPaths(projectRoot).knowledgeDir, note.targetDir);
}

/** ノート本文(`## 要約` / `## 詳細` / `## 出典・参考`)。 */
function noteBody(note: ParsedTopicNote): string {
  return buildBody({ summary: note.summary, detail: note.detail, refs: note.references });
}

/**
 * `categories[0] === targetDir` かつ単一セグメント・実ディレクトリ一致を検査する(設計 §8-M / §10-2-3)。
 * lock 取得前に全ノートぶん実行して fail-fast する(部分書き込みを避ける)。
 */
function assertInvariants(projectRoot: string, notes: ParsedTopicNote[]): void {
  for (const note of notes) {
    if (note.categories[0] !== note.targetDir) {
      throw new MnemoError('CATEGORY_INVARIANT', 'categories[0] は targetDir と一致する必要があります', {
        expected: note.targetDir,
        actual: note.categories[0] ?? null,
        slug: note.slug,
      });
    }
    const primaryAbs = path.join(noteDir(projectRoot, note), `${note.slug}.md`);
    const fmForCheck = { categories: note.categories } as unknown as Frontmatter;
    assertCategoryPathInvariant(fmForCheck, primaryAbs, projectRoot, { requireSingleSegment: true });
  }
}

/** dry-run 用の衝突予定(FS を読むだけ。ファイルは作らない)。設計 §8-M。 */
async function planCollision(
  dir: string,
  slug: string,
  strategy: ParsedTopicNote['collisionStrategy'],
): Promise<{ collision: StorePlanLike['willCreate'][number]['collision']; absPath: string }> {
  const primary = path.join(dir, `${slug}.md`);
  if (!(await pathExists(primary))) {
    return { collision: 'none', absPath: primary };
  }
  if (strategy === 'abort') {
    return { collision: 'abort', absPath: primary };
  }
  if (strategy === 'append-to-existing') {
    return { collision: 'append', absPath: primary };
  }
  // auto-number: resolveCollision に実ファイル名(-2.md 等)を決めさせる。
  const resolved = await resolveCollision(dir, slug, 'auto-number');
  return { collision: 'auto-number', absPath: resolved.absPath };
}

// ───────────────────────── StorePlan(dry-run)─────────────────────────

async function buildPlan(projectRoot: string, notes: ParsedTopicNote[]): Promise<StorePlanLike> {
  const willCreate: StorePlanLike['willCreate'] = [];
  const piiWarnings = new Map<string, number>();
  const piiBlocks: StorePlanLike['piiBlocks'] = [];
  const newCategories = new Set<string>();
  let totalApproxChars = 0;

  for (const note of notes) {
    const dir = noteDir(projectRoot, note);
    if (!(await pathExists(dir))) {
      newCategories.add(note.targetDir);
    }

    const { collision, absPath } = await planCollision(dir, note.slug, note.collisionStrategy);
    willCreate.push({
      slug: note.slug,
      path: toRelPosix(projectRoot, absPath),
      title: note.title,
      categorySegment: note.targetDir,
      summary: note.summary,
      collision,
    });

    totalApproxChars +=
      note.summary.length + note.detail.length + (note.references?.length ?? 0);

    const scan = scanPii(noteBody(note), { noteSlug: note.slug });
    for (const w of scan.warns) {
      piiWarnings.set(w.pattern, (piiWarnings.get(w.pattern) ?? 0) + 1);
    }
    for (const b of scan.blocks) {
      piiBlocks.push({ pattern: b.pattern, noteSlug: note.slug, masked: b.masked });
    }
  }

  return {
    willCreate,
    piiWarnings: [...piiWarnings.entries()].map(([pattern, count]) => ({ pattern, count })),
    piiBlocks,
    newCategories: [...newCategories],
    totalApproxChars,
  };
}

function planResult(plan: StorePlanLike, extraText = ''): CallToolResult {
  const text = extraText === '' ? formatStorePlan(plan) : `${extraText}\n\n${formatStorePlan(plan)}`;
  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: { plan: plan as unknown as Record<string, unknown> },
  };
}

// ───────────────────────── apply 本体 ─────────────────────────

interface WriteOutcome {
  created: StoreResultLike['created'];
  appended: Array<{ slug: string; path: string; id: string }>;
  /** 変更のあった vault 相対パス(reindex / usage_log 用)。 */
  paths: string[];
  categories: string[];
}

async function applyNotes(projectRoot: string, notes: ParsedTopicNote[]): Promise<WriteOutcome> {
  const created: StoreResultLike['created'] = [];
  const appended: Array<{ slug: string; path: string; id: string }> = [];
  const paths: string[] = [];
  const rollbacks: Array<() => Promise<void>> = [];
  const ts = nowIso();
  const day = ts.slice(0, 10);

  try {
    for (const note of notes) {
      const dir = noteDir(projectRoot, note);
      const resolved = await resolveCollision(dir, note.slug, note.collisionStrategy);
      const absPath = resolved.absPath;
      const relPath = toRelPosix(projectRoot, absPath);

      if (resolved.action === 'append') {
        const originalRaw = await fs.promises.readFile(absPath, 'utf8');
        const existing = await readNote(absPath);
        const mergedTags = dedupe([...(existing.fm.tags ?? []), ...note.tags]);
        const nextFm: Frontmatter = { ...existing.fm, tags: mergedTags, updated: ts };
        assertCategoryPathInvariant(nextFm, absPath, projectRoot, { requireSingleSegment: true });
        const nextBody = `${existing.body.replace(/\s+$/, '')}\n\n---\n\n## 追記 (${day})\n\n${note.detail}\n`;
        await writeNote(absPath, nextFm, nextBody);
        rollbacks.push(() => fs.promises.writeFile(absPath, originalRaw, 'utf8'));
        appended.push({ slug: note.slug, path: relPath, id: existing.fm.id });
        paths.push(relPath);
        continue;
      }

      const id = newId();
      const fm: Frontmatter = {
        id,
        title: note.title,
        categories: note.categories,
        tags: dedupe(note.tags),
        created: ts,
        updated: ts,
        summary: note.summary,
        ...(note.source ? { source: note.source } : {}),
      };
      assertCategoryPathInvariant(fm, absPath, projectRoot, { requireSingleSegment: true });
      await writeNote(absPath, fm, noteBody(note));
      rollbacks.push(() => fs.promises.rm(absPath, { force: true }));
      created.push({ slug: note.slug, path: relPath, id });
      paths.push(relPath);
    }
  } catch (err) {
    // 途中失敗 → ここまでの書き込みを逆順に巻き戻す(原子性。設計 §8-M step 4)。
    for (const undo of rollbacks.reverse()) {
      await undo().catch(() => {
        /* ロールバック失敗はこれ以上どうにもできない */
      });
    }
    throw err;
  }

  return { created, appended, paths, categories: dedupe(notes.map((n) => n.targetDir)) };
}

function vaultError(reason: string | undefined): MnemoError {
  if (reason === 'vault-not-writable') {
    return new MnemoError('VAULT_NOT_WRITABLE', 'vault/ に書き込めません', { reason });
  }
  return new MnemoError('VAULT_UNAVAILABLE', 'vault/ にアクセスできません', { reason: reason ?? 'unknown' });
}

// ───────────────────────── handler ─────────────────────────

async function storeHandler(args: unknown, ctx: ToolContext): Promise<CallToolResult> {
  const input: ParsedStoreInput = StoreInputSchema.parse(args);
  const { projectRoot } = ctx;
  const notes = input.notes;
  const notesHash = hashNotes(notes);

  // ── dry-run ──────────────────────────────────────────────
  if (!input.apply) {
    seenDryRuns.set(notesHash, Date.now());
    const plan = await buildPlan(projectRoot, notes);
    return planResult(plan);
  }

  // ── 誤 apply の保険(設計 §8-M step 2)──────────────────────
  const seenAt = seenDryRuns.get(notesHash);
  if (seenAt === undefined || Date.now() - seenAt > DRY_RUN_TTL_MS) {
    const plan = await buildPlan(projectRoot, notes);
    return planResult(
      plan,
      'まだ保存予定の確認(apply:false)が行われていません。' +
        'まず apply:false で下記の保存予定をユーザーに提示・承認を得てから apply:true を再送してください。',
    );
  }

  // ── apply(設計 §8-M step 3〜8)────────────────────────────
  const vault = await checkVault(projectRoot);
  if (!vault.ok) {
    throw vaultError(vault.reason);
  }

  // PII BLOCK: 1 件でもあればファイルを作らず中止(設計 §7 / §8-M step 3)。
  const blocks: Array<{ pattern: string; noteSlug: string; masked: string }> = [];
  for (const note of notes) {
    for (const b of scanPii(noteBody(note), { noteSlug: note.slug }).blocks) {
      blocks.push({ pattern: b.pattern, noteSlug: note.slug, masked: b.masked });
    }
  }
  if (blocks.length > 0) {
    throw new MnemoError('PII_BLOCKED', '本文に機密情報(クレデンシャル等)が含まれています', {
      hits: blocks,
    });
  }

  // 不変条件(categories[0] === targetDir・単一セグメント・実ディレクトリ一致)。
  assertInvariants(projectRoot, notes);

  const outcome = await withLock(projectRoot, 'knowledge', () => applyNotes(projectRoot, notes));

  await regenerateCategories(projectRoot);

  let reindexFellBack = false;
  try {
    const r = await reindexPaths(projectRoot, outcome.paths);
    reindexFellBack = r.serverFellBack;
  } catch {
    // インデックス更新失敗は保存自体を失敗させない(ファイルは既に書けている)。
    reindexFellBack = true;
  }

  await appendUsage(projectRoot, {
    ts: nowIso(),
    mode: 'store',
    event: 'store.apply',
    ok: true,
    count: outcome.paths.length,
    paths: outcome.paths,
    categories: outcome.categories,
    approxChars: notes.reduce(
      (sum, n) => sum + n.summary.length + n.detail.length + (n.references?.length ?? 0),
      0,
    ),
  });

  const result: StoreResultLike = {
    created: outcome.created,
    appended: outcome.appended.map((a) => ({ slug: a.slug, path: a.path, id: a.id })),
    categoriesRegenerated: true,
  };
  const text =
    formatStoreResult(result) +
    (reindexFellBack ? '\n(検索インデックスはファイル直更新で反映しました。)' : '');

  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: {
      created: result.created as unknown as Record<string, unknown>[],
      appended: result.appended as unknown as Record<string, unknown>[],
      categoriesRegenerated: true,
    },
  };
}

// ───────────────────────── ToolModule(default export)─────────────────────────

const storeModule: ToolModule = {
  name: 'mnemo_store',
  config: {
    title: '会話内容をトピック分解してナレッジ保存',
    description: STORE_DESCRIPTION,
    inputSchema: StoreInputSchema,
  },
  handler: storeHandler,
};

export default storeModule;
