// test/mcp/tools/organize.preview.test.ts — 設計書 §13-11「preview」。
//
// organizePreviewModule(mnemo_organize_preview)の単体テスト:
//   - 選択提案の FileOp 列が SuggestionKind 別に正しい(§8-N 写像表)
//   - duplicate の mergedBodyPreview(結合本文の先頭 2000 字)
//   - 提案間競合(move + delete)→ throw せず combinedConflicts に載る
//   - session 照合失敗 / expiresAt 超過 / applying:true → ORGANIZE_SESSION_EXPIRED

import fs from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { isMnemoError } from '../../../src/core/errors.js';
import type { Frontmatter } from '../../../src/core/frontmatter.js';
import { noteAbsPathForCategory, writeNote } from '../../../src/core/note.js';
import { vaultPaths } from '../../../src/core/paths.js';
import { MERGED_BODY_PREVIEW_MAX } from '../../../src/mcp/organize/preview.js';
import {
  buildSession,
  readSession,
  writeSession,
} from '../../../src/mcp/organize/session.js';
import { organizePreviewModule, organizeScanModule } from '../../../src/mcp/tools/organize.js';
import type { ToolContext } from '../../../src/mcp/tools/types.js';
import { makeProject } from '../../helpers/project.js';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const d = roots.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

async function mkProject(): Promise<string> {
  const root = await makeProject();
  roots.push(root);
  return root;
}

function ctx(projectRoot: string): ToolContext {
  return { projectRoot };
}

let seq = 0;
async function addNote(
  root: string,
  category: string,
  slug: string,
  opts: { title?: string; body?: string; categories?: string[]; tags?: string[] } = {},
): Promise<string> {
  seq += 1;
  const fm: Frontmatter = {
    id: `20260901T0930${String(seq).padStart(6, '0')}`,
    title: opts.title ?? `${category}/${slug}`,
    categories: opts.categories ?? [category],
    tags: opts.tags ?? [],
    created: '2026-09-01T09:30:00+09:00',
    updated: '2026-09-01T09:30:00+09:00',
    summary: '',
  };
  await writeNote(noteAbsPathForCategory(root, category, slug), fm, opts.body ?? `## 要約\n\n${slug} 本文\n`);
  return category === '_uncategorized' ? `knowledge/_uncategorized/${slug}.md` : `knowledge/${category}/${slug}.md`;
}

interface PreviewSC {
  sessionId: string;
  diffs: {
    proposalId: string;
    kind: string;
    fileOps: { op: string; from?: string; to?: string; frontmatterPatch?: Record<string, unknown> }[];
    mergedBodyPreview?: string;
    conflicts: string[];
  }[];
  combinedConflicts: string[];
}

async function scan(root: string): Promise<{ sessionId: string; proposals: { proposalId: string; kind: string }[] }> {
  const res = await organizeScanModule.handler({ apply: false, scope: 'all' }, ctx(root));
  const sc = res.structuredContent as { sessionId: string; proposals: { proposalId: string; kind: string }[] };
  return sc;
}

describe('organizePreviewModule (mnemo_organize_preview — §8-N / §13-11)', () => {
  it('module メタ情報: name / inputSchema あり', () => {
    expect(organizePreviewModule.name).toBe('mnemo_organize_preview');
    expect(organizePreviewModule.config.inputSchema).toBeDefined();
  });

  it('fix-frontmatter → rewrite-frontmatter FileOp(categories パッチ付き)', async () => {
    const root = await mkProject();
    // knowledge/alpha/ に置くが categories は ['beta'] → category-path-mismatch
    await addNote(root, 'alpha', 'mismatch', { categories: ['beta'], title: 'ミスマッチ' });
    const { sessionId, proposals } = await scan(root);
    const fix = proposals.find((p) => p.kind === 'fix-frontmatter');
    expect(fix).toBeDefined();

    const res = await organizePreviewModule.handler(
      { sessionId, proposalIds: [fix!.proposalId] },
      ctx(root),
    );
    const sc = res.structuredContent as PreviewSC;
    const diff = sc.diffs[0]!;
    expect(diff.fileOps).toHaveLength(1);
    expect(diff.fileOps[0]!.op).toBe('rewrite-frontmatter');
    expect(diff.fileOps[0]!.from).toBe('knowledge/alpha/mismatch.md');
    expect(diff.fileOps[0]!.to).toBe('knowledge/alpha/mismatch.md');
    expect(diff.fileOps[0]!.frontmatterPatch).toEqual({ categories: ['alpha'] });
    expect(diff.conflicts).toEqual([]);
    expect((res.content[0] as { text: string }).text).toContain(diff.proposalId);
  });

  it('duplicate → merge-into + delete FileOp 列 と mergedBodyPreview', async () => {
    const root = await mkProject();
    await addNote(root, 'aaa', 'one', { title: '同じタイトル', body: '## 要約\n\nAAA 固有の本文\n' });
    await addNote(root, 'bbb', 'two', { title: '同じタイトル', body: '## 要約\n\nBBB 固有の本文\n' });
    const { sessionId, proposals } = await scan(root);
    const dup = proposals.find((p) => p.kind === 'duplicate');
    expect(dup).toBeDefined();

    const res = await organizePreviewModule.handler(
      { sessionId, proposalIds: [dup!.proposalId] },
      ctx(root),
    );
    const diff = (res.structuredContent as PreviewSC).diffs[0]!;
    // targets ソート順: knowledge/aaa/one.md < knowledge/bbb/two.md
    expect(diff.fileOps).toEqual([
      { op: 'merge-into', from: 'knowledge/bbb/two.md', to: 'knowledge/aaa/one.md' },
      { op: 'delete', from: 'knowledge/bbb/two.md' },
    ]);
    expect(diff.mergedBodyPreview).toContain('AAA 固有の本文');
    expect(diff.mergedBodyPreview).toContain('BBB 固有の本文');
    expect((res.content[0] as { text: string }).text).toContain('統合後本文');
  });

  it('mergedBodyPreview は先頭 2000 字で切り詰められる', async () => {
    const root = await mkProject();
    const big = `## 要約\n\n${'あ'.repeat(5000)}\n`;
    await addNote(root, 'aaa', 'one', { title: 'T', body: big });
    await addNote(root, 'bbb', 'two', { title: 'T', body: '## 要約\n\nsmall\n' });
    const { sessionId, proposals } = await scan(root);
    const dup = proposals.find((p) => p.kind === 'duplicate')!;
    const res = await organizePreviewModule.handler(
      { sessionId, proposalIds: [dup.proposalId] },
      ctx(root),
    );
    const diff = (res.structuredContent as PreviewSC).diffs[0]!;
    expect(diff.mergedBodyPreview!.length).toBe(MERGED_BODY_PREVIEW_MAX);
  });

  it('move-uncategorized → mkdir + move FileOp(categories パッチ付き)', async () => {
    const root = await mkProject();
    const shared = '## 要約\n\nKubernetes と Helm のデプロイ手順とロールバック戦略について\n';
    await addNote(root, 'infra', 't', { title: 'infra note', body: shared });
    await addNote(root, '_uncategorized', 'loose', { title: 'loose note', body: shared });
    const { sessionId, proposals } = await scan(root);
    const mv = proposals.find((p) => p.kind === 'move-uncategorized');
    expect(mv).toBeDefined();

    const res = await organizePreviewModule.handler(
      { sessionId, proposalIds: [mv!.proposalId] },
      ctx(root),
    );
    const diff = (res.structuredContent as PreviewSC).diffs[0]!;
    expect(diff.fileOps[0]).toEqual({ op: 'mkdir', to: 'knowledge/infra' });
    expect(diff.fileOps[1]).toEqual({
      op: 'move',
      from: 'knowledge/_uncategorized/loose.md',
      to: 'knowledge/infra/loose.md',
      frontmatterPatch: { categories: ['infra'] },
    });
  });

  it('提案間競合(move + delete)→ throw せず combinedConflicts / conflicts に載る', async () => {
    const root = await mkProject();
    const shared = '## 要約\n\nKubernetes と Helm のデプロイ手順とロールバック戦略について\n';
    await addNote(root, 'infra', 't', { title: 'infra note', body: shared });
    // 同一本文の _uncategorized ノート 2 本 → どちらも move-uncategorized 候補、
    // かつ 3 本まとめて duplicate(body-hash 一致)。targets ソートで 2 本目(loose-b)が
    // duplicate の source(delete)になり、move-uncategorized の move と競合する。
    await addNote(root, '_uncategorized', 'loose-a', { title: 'la', body: shared });
    await addNote(root, '_uncategorized', 'loose-b', { title: 'lb', body: shared });

    const { sessionId, proposals } = await scan(root);
    const dup = proposals.find((p) => p.kind === 'duplicate')!;
    const moves = proposals.filter((p) => p.kind === 'move-uncategorized');
    expect(moves.length).toBe(2);

    const res = await organizePreviewModule.handler(
      { sessionId, proposalIds: [dup.proposalId, ...moves.map((m) => m.proposalId)] },
      ctx(root),
    );
    const sc = res.structuredContent as PreviewSC;
    expect(res.isError).toBeUndefined();
    expect(sc.combinedConflicts.length).toBeGreaterThan(0);
    expect(sc.combinedConflicts.join('\n')).toContain('knowledge/_uncategorized/loose-b.md');
    // 競合に関与した提案の diff.conflicts にも同じ説明が入る
    const withConflict = sc.diffs.filter((d) => d.conflicts.length > 0);
    expect(withConflict.length).toBeGreaterThanOrEqual(2);
    expect((res.content[0] as { text: string }).text).toContain('競合');
  });

  it('未知の proposalId は無視して combinedConflicts に情報行を残す(throw しない)', async () => {
    const root = await mkProject();
    await addNote(root, 'alpha', 'mismatch', { categories: ['beta'] });
    const { sessionId } = await scan(root);
    const res = await organizePreviewModule.handler(
      { sessionId, proposalIds: ['does-not-exist-9'] },
      ctx(root),
    );
    const sc = res.structuredContent as PreviewSC;
    expect(sc.diffs).toEqual([]);
    expect(sc.combinedConflicts.join('\n')).toContain('does-not-exist-9');
  });

  it('session 照合失敗(未知 sessionId)→ ORGANIZE_SESSION_EXPIRED', async () => {
    const root = await mkProject();
    await addNote(root, 'alpha', 'x');
    await scan(root);
    let caught: unknown;
    try {
      await organizePreviewModule.handler(
        { sessionId: 'org-nonexistent', proposalIds: ['fix-frontmatter-1'] },
        ctx(root),
      );
    } catch (e) {
      caught = e;
    }
    expect(isMnemoError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe('ORGANIZE_SESSION_EXPIRED');
  });

  it('expiresAt 超過 → ORGANIZE_SESSION_EXPIRED', async () => {
    const root = await mkProject();
    const base = buildSession('org-expired', '2026-09-01T00:00:00.000Z', []);
    await writeSession(root, { ...base, expiresAt: '2026-09-01T00:00:00.000Z' });

    let caught: unknown;
    try {
      await organizePreviewModule.handler(
        { sessionId: 'org-expired', proposalIds: ['x-1'] },
        ctx(root),
      );
    } catch (e) {
      caught = e;
    }
    expect(isMnemoError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe('ORGANIZE_SESSION_EXPIRED');
  });

  it('applying:true の session → ORGANIZE_SESSION_EXPIRED(detail で復旧誘導)', async () => {
    const root = await mkProject();
    const base = buildSession('org-applying', new Date().toISOString(), []);
    await writeSession(root, { ...base, applying: true, snapshotId: 'organize-1' });

    let caught: unknown;
    try {
      await organizePreviewModule.handler(
        { sessionId: 'org-applying', proposalIds: ['x-1'] },
        ctx(root),
      );
    } catch (e) {
      caught = e;
    }
    expect(isMnemoError(caught)).toBe(true);
    const err = caught as { code: string; details?: Record<string, unknown> };
    expect(err.code).toBe('ORGANIZE_SESSION_EXPIRED');
    expect(String(err.details?.detail)).toContain('pendingRecovery');
  });

  it('preview はファイルを変更しない(dry-run)', async () => {
    const root = await mkProject();
    await addNote(root, 'aaa', 'one', { title: 'T', body: '## 要約\n\nA\n' });
    await addNote(root, 'bbb', 'two', { title: 'T', body: '## 要約\n\nB\n' });
    const { sessionId, proposals } = await scan(root);
    const dup = proposals.find((p) => p.kind === 'duplicate')!;

    const vaultRoot = vaultPaths(root).root;
    const snapshot = (): string[] =>
      fs.readdirSync(vaultRoot, { recursive: true }).map(String).sort();
    const before = snapshot();
    const sessionBefore = JSON.stringify((await readSession(root)).session);

    await organizePreviewModule.handler({ sessionId, proposalIds: [dup.proposalId] }, ctx(root));

    expect(snapshot()).toEqual(before);
    expect(JSON.stringify((await readSession(root)).session)).toBe(sessionBefore);
  });
});
