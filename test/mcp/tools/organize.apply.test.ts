// test/mcp/tools/organize.apply.test.ts — 設計書 §13-11「apply」「ロールバック」「lock scope」「クラッシュ復帰」。
//
// organizeApplyModule(mnemo_organize_apply)の単体テスト:
//   - confirmedDestructive 欠落 → DESTRUCTIVE_NOT_CONFIRMED
//   - 正常 apply → snapshot 作成 → FileOp 実行 → summary 正確 → categories 再生成 → gc
//   - ロールバック → restoreSnapshot で全戻し・MnemoError・session 削除
//   - lock scope(単一カテゴリ → category:x / 横断 → vault)
//   - クラッシュ復帰(finalize 直前 throw + restore も失敗 → applying:true 残存 →
//     次の scan は pendingRecovery / apply 再突入は ORGANIZE_SESSION_EXPIRED)
//   - PII_BLOCKED(merge-into の新規本文に AWS 公式 example キー)
//   - PROPOSAL_CONFLICT / ORGANIZE_SESSION_EXPIRED

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { regenerateCategories } from '../../../src/core/categories-index.js';
import { isMnemoError } from '../../../src/core/errors.js';
import type { Frontmatter } from '../../../src/core/frontmatter.js';
import { noteAbsPathForCategory, writeNote } from '../../../src/core/note.js';
import { vaultPaths } from '../../../src/core/paths.js';
import * as snapshotMod from '../../../src/core/snapshot.js';
import { listSnapshots } from '../../../src/core/snapshot.js';
import * as applyMod from '../../../src/mcp/organize/apply.js';
import { decideLockScope } from '../../../src/mcp/organize/apply.js';
import type { FileOp } from '../../../src/mcp/organize/preview.js';
import { readSession } from '../../../src/mcp/organize/session.js';
import { scanVault } from '../../../src/mcp/organize/scan.js';
import { organizeApplyModule, organizeScanModule } from '../../../src/mcp/tools/organize.js';
import type { ToolContext } from '../../../src/mcp/tools/types.js';
import { makeProject } from '../../helpers/project.js';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
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
  return `knowledge/${category}/${slug}.md`;
}

interface ScanSC {
  sessionId: string;
  proposals: { proposalId: string; kind: string; destructiveness: string }[];
}

async function scan(root: string): Promise<ScanSC> {
  const res = await organizeScanModule.handler({ apply: false, scope: 'all' }, ctx(root));
  return res.structuredContent as ScanSC;
}

interface ApplySC {
  snapshot: string;
  applied: string[];
  summary: {
    dirsCreated: string[];
    dirsRemoved: string[];
    filesMoved: { from: string; to: string }[];
    filesMerged: { sources: string[]; into: string }[];
    filesDeleted: string[];
    frontmatterFixed: string[];
  };
}

function exists(root: string, rel: string): boolean {
  return fs.existsSync(path.join(vaultPaths(root).root, ...rel.split('/')));
}

describe('organizeApplyModule (mnemo_organize_apply — §8-N / §13-11)', () => {
  it('module メタ情報: name / inputSchema あり', () => {
    expect(organizeApplyModule.name).toBe('mnemo_organize_apply');
    expect(organizeApplyModule.config.inputSchema).toBeDefined();
  });

  it('正常 apply(fix-frontmatter): snapshot 作成 → frontmatter 修正 → session 削除 → categories 再生成', async () => {
    const root = await mkProject();
    await addNote(root, 'alpha', 'mismatch', { categories: ['beta'], title: 'ミスマッチ' });
    const { sessionId, proposals } = await scan(root);
    const fix = proposals.find((p) => p.kind === 'fix-frontmatter')!;
    expect(fix).toBeDefined();

    const res = await organizeApplyModule.handler(
      { sessionId, proposalIds: [fix.proposalId], label: 'organize', confirmedDestructive: [] },
      ctx(root),
    );
    const sc = res.structuredContent as ApplySC;

    expect(sc.applied).toEqual([fix.proposalId]);
    expect(sc.summary.frontmatterFixed).toEqual(['knowledge/alpha/mismatch.md']);
    // snapshot が実在する
    const snaps = await listSnapshots(root);
    expect(snaps.map((s) => s.id)).toContain(sc.snapshot);
    // session ファイルは消えている(applying を残さない)
    const { session } = await readSession(root);
    expect(session).toBeNull();
    // frontmatter が是正され categories/*.md が再生成されている
    const raw = fs.readFileSync(path.join(vaultPaths(root).root, 'knowledge/alpha/mismatch.md'), 'utf8');
    expect(raw).toMatch(/categories:\s*\[\s*alpha\s*\]/);
    expect(fs.existsSync(path.join(vaultPaths(root).root, 'categories/alpha.md'))).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain(sc.snapshot);
  });

  it('正常 apply(move-uncategorized): ファイル移動と summary.filesMoved', async () => {
    const root = await mkProject();
    const shared = '## 要約\n\nKubernetes と Helm のデプロイ手順とロールバック戦略について\n';
    await addNote(root, 'infra', 't', { title: 'infra note', body: shared });
    await addNote(root, '_uncategorized', 'loose', { title: 'loose note', body: shared });
    const { sessionId, proposals } = await scan(root);
    const mv = proposals.find((p) => p.kind === 'move-uncategorized')!;
    expect(mv).toBeDefined();

    const res = await organizeApplyModule.handler(
      { sessionId, proposalIds: [mv.proposalId], label: 'organize', confirmedDestructive: [] },
      ctx(root),
    );
    const sc = res.structuredContent as ApplySC;
    expect(sc.summary.filesMoved).toEqual([
      { from: 'knowledge/_uncategorized/loose.md', to: 'knowledge/infra/loose.md' },
    ]);
    expect(exists(root, 'knowledge/_uncategorized/loose.md')).toBe(false);
    expect(exists(root, 'knowledge/infra/loose.md')).toBe(true);
  });

  it('confirmedDestructive 欠落 → DESTRUCTIVE_NOT_CONFIRMED', async () => {
    const root = await mkProject();
    await addNote(root, 'aaa', 'one', { title: '同じタイトル', body: '## 要約\n\nAAA\n' });
    await addNote(root, 'bbb', 'two', { title: '同じタイトル', body: '## 要約\n\nBBB\n' });
    const { sessionId, proposals } = await scan(root);
    const dup = proposals.find((p) => p.kind === 'duplicate')!;
    expect(dup.destructiveness).toBe('merge');

    const err = await organizeApplyModule
      .handler(
        { sessionId, proposalIds: [dup.proposalId], label: 'organize', confirmedDestructive: [] },
        ctx(root),
      )
      .catch((e: unknown) => e);
    expect(isMnemoError(err)).toBe(true);
    expect((err as { code: string }).code).toBe('DESTRUCTIVE_NOT_CONFIRMED');
    // ファイルは無変更
    expect(exists(root, 'knowledge/aaa/one.md')).toBe(true);
    expect(exists(root, 'knowledge/bbb/two.md')).toBe(true);
  });

  it('正常 apply(duplicate, confirmed): merge → delete → summary 正確', async () => {
    const root = await mkProject();
    await addNote(root, 'aaa', 'one', { title: 'T', body: '## 要約\n\nAAA 固有\n', tags: ['x'] });
    await addNote(root, 'aaa', 'two', { title: 'T', body: '## 要約\n\nBBB 固有\n', tags: ['y'] });
    const { sessionId, proposals } = await scan(root);
    const dup = proposals.find((p) => p.kind === 'duplicate')!;

    const res = await organizeApplyModule.handler(
      {
        sessionId,
        proposalIds: [dup.proposalId],
        label: 'organize',
        confirmedDestructive: [dup.proposalId],
      },
      ctx(root),
    );
    const sc = res.structuredContent as ApplySC;
    expect(sc.summary.filesMerged).toEqual([
      { sources: ['knowledge/aaa/two.md'], into: 'knowledge/aaa/one.md' },
    ]);
    expect(sc.summary.filesDeleted).toEqual(['knowledge/aaa/two.md']);
    expect(exists(root, 'knowledge/aaa/two.md')).toBe(false);
    const merged = fs.readFileSync(path.join(vaultPaths(root).root, 'knowledge/aaa/one.md'), 'utf8');
    expect(merged).toContain('AAA 固有');
    expect(merged).toContain('BBB 固有');
    // tags 和集合(x ∪ y)
    const tagsLine = merged.split('\n').find((l) => l.startsWith('tags:')) ?? '';
    expect(tagsLine).toContain('x');
    expect(tagsLine).toContain('y');
  });

  it('gc: 6 回 apply したらスナップショットは 5 世代に保たれる', async () => {
    const root = await mkProject();
    for (let i = 0; i < 6; i += 1) {
      await addNote(root, 'g', `n${i}`, { categories: ['wrong'], title: `n${i}` });
      const { sessionId, proposals } = await scan(root);
      const fix = proposals.find(
        (p) => p.kind === 'fix-frontmatter' && p.proposalId.length > 0,
      )!;
      await organizeApplyModule.handler(
        { sessionId, proposalIds: [fix.proposalId], label: 'organize', confirmedDestructive: [] },
        ctx(root),
      );
    }
    const snaps = await listSnapshots(root);
    expect(snaps.length).toBe(5);
  });

  it('ロールバック: FileOp 実行途中失敗 → restoreSnapshot で全戻し + throw + session 削除', async () => {
    const root = await mkProject();
    await addNote(root, 'aaa', 'one', { title: 'T', body: '## 要約\n\nAAA\n' });
    await addNote(root, 'aaa', 'two', { title: 'T', body: '## 要約\n\nBBB\n' });
    const { sessionId, proposals } = await scan(root);
    const dup = proposals.find((p) => p.kind === 'duplicate')!;

    // snapshot 作成・applying:true 書き込みの後で FileOp 実行が失敗する状況を模擬。
    const spy = vi
      .spyOn(applyMod, 'executeFileOps')
      .mockRejectedValue(new Error('disk full mid-op'));

    const err = await organizeApplyModule
      .handler(
        {
          sessionId,
          proposalIds: [dup.proposalId],
          label: 'organize',
          confirmedDestructive: [dup.proposalId],
        },
        ctx(root),
      )
      .catch((e: unknown) => e);
    expect(spy).toHaveBeenCalled();
    expect(err).toBeInstanceOf(Error);
    // restoreSnapshot で snapshot 時点(2 本とも存在)に戻る
    expect(exists(root, 'knowledge/aaa/one.md')).toBe(true);
    expect(exists(root, 'knowledge/aaa/two.md')).toBe(true);
    // session は削除済み(restore 成功したので applying を残さない)
    const { session } = await readSession(root);
    expect(session).toBeNull();
  });

  it('PII_BLOCKED: merge-into の統合後本文に AWS 公式 example キーが含まれる', async () => {
    const root = await mkProject();
    await addNote(root, 'aaa', 'one', { title: 'T', body: '## 要約\n\nクリーンな本文\n' });
    await addNote(root, 'aaa', 'two', {
      title: 'T',
      body: '## 要約\n\nAWS key: AKIAIOSFODNN7EXAMPLE\n',
    });
    const { sessionId, proposals } = await scan(root);
    const dup = proposals.find((p) => p.kind === 'duplicate')!;

    const err = await organizeApplyModule
      .handler(
        {
          sessionId,
          proposalIds: [dup.proposalId],
          label: 'organize',
          confirmedDestructive: [dup.proposalId],
        },
        ctx(root),
      )
      .catch((e: unknown) => e);
    expect(isMnemoError(err)).toBe(true);
    expect((err as { code: string }).code).toBe('PII_BLOCKED');
    // ロールバックで両ファイル健在
    expect(exists(root, 'knowledge/aaa/one.md')).toBe(true);
    expect(exists(root, 'knowledge/aaa/two.md')).toBe(true);
  });

  it('PROPOSAL_CONFLICT: 選択提案どうしが矛盾(move + delete)', async () => {
    const root = await mkProject();
    const shared = '## 要約\n\nKubernetes と Helm のデプロイ手順とロールバック戦略について\n';
    await addNote(root, 'infra', 't', { title: 'infra note', body: shared });
    await addNote(root, '_uncategorized', 'loose-a', { title: 'la', body: shared });
    await addNote(root, '_uncategorized', 'loose-b', { title: 'lb', body: shared });
    const { sessionId, proposals } = await scan(root);
    const dup = proposals.find((p) => p.kind === 'duplicate')!;
    const moves = proposals.filter((p) => p.kind === 'move-uncategorized');

    const err = await organizeApplyModule
      .handler(
        {
          sessionId,
          proposalIds: [dup.proposalId, ...moves.map((m) => m.proposalId)],
          label: 'organize',
          confirmedDestructive: [dup.proposalId],
        },
        ctx(root),
      )
      .catch((e: unknown) => e);
    expect(isMnemoError(err)).toBe(true);
    expect((err as { code: string }).code).toBe('PROPOSAL_CONFLICT');
  });

  it('ORGANIZE_SESSION_EXPIRED: 未知 sessionId', async () => {
    const root = await mkProject();
    await addNote(root, 'alpha', 'mismatch', { categories: ['beta'] });
    await scan(root);
    const err = await organizeApplyModule
      .handler(
        { sessionId: 'org-nope', proposalIds: ['fix-frontmatter-1'], label: 'organize', confirmedDestructive: [] },
        ctx(root),
      )
      .catch((e: unknown) => e);
    expect(isMnemoError(err)).toBe(true);
    expect((err as { code: string }).code).toBe('ORGANIZE_SESSION_EXPIRED');
  });

  describe('decideLockScope (§8-N step5)', () => {
    it('単一カテゴリ内で完結 → category:<seg>', () => {
      const ops: FileOp[] = [
        { op: 'mkdir', to: 'knowledge/tech/sub' },
        { op: 'move', from: 'knowledge/tech/a.md', to: 'knowledge/tech/sub/a.md' },
      ];
      expect(decideLockScope(ops, ['split-category'])).toBe('category:tech');
    });

    it('複数トップレベルカテゴリを触る → vault', () => {
      const ops: FileOp[] = [
        { op: 'move', from: 'knowledge/a/x.md', to: 'knowledge/b/x.md' },
      ];
      expect(decideLockScope(ops, ['move-uncategorized'])).toBe('vault');
    });

    it('merge-category を含む → vault', () => {
      const ops: FileOp[] = [{ op: 'rmdir', from: 'knowledge/b' }];
      expect(decideLockScope(ops, ['merge-category'])).toBe('vault');
    });
  });

  describe('クラッシュ復帰(§12-10 / §10-5 applying フラグ)', () => {
    it('finalize 直前 throw + restore も失敗 → applying:true + snapshotId 残存 → SNAPSHOT_FAILED', async () => {
      const root = await mkProject();
      await addNote(root, 'alpha', 'mismatch', { categories: ['beta'] });
      const { sessionId, proposals } = await scan(root);
      const fix = proposals.find((p) => p.kind === 'fix-frontmatter')!;

      vi.spyOn(snapshotMod, 'finalizeSnapshotManifest').mockRejectedValue(new Error('crash'));
      vi.spyOn(snapshotMod, 'restoreSnapshot').mockRejectedValue(new Error('restore failed'));

      const err = await organizeApplyModule
        .handler(
          { sessionId, proposalIds: [fix.proposalId], label: 'organize', confirmedDestructive: [] },
          ctx(root),
        )
        .catch((e: unknown) => e);
      expect(isMnemoError(err)).toBe(true);
      expect((err as { code: string }).code).toBe('SNAPSHOT_FAILED');

      const { session } = await readSession(root);
      expect(session).not.toBeNull();
      expect(session!.applying).toBe(true);
      expect(typeof session!.snapshotId).toBe('string');
      expect(session!.snapshotId!.length).toBeGreaterThan(0);

      vi.restoreAllMocks();

      // scan 契機: pendingRecovery を返す(スキャンしない)
      const rescan = await scanVault(root);
      expect(rescan.pendingRecovery).not.toBeNull();
      expect(rescan.pendingRecovery!.snapshotId).toBe(session!.snapshotId);
      expect(rescan.proposals).toEqual([]);

      // apply 再突入 → ORGANIZE_SESSION_EXPIRED(前回未完了)
      const err2 = await organizeApplyModule
        .handler(
          { sessionId, proposalIds: [fix.proposalId], label: 'organize', confirmedDestructive: [] },
          ctx(root),
        )
        .catch((e: unknown) => e);
      expect(isMnemoError(err2)).toBe(true);
      expect((err2 as { code: string }).code).toBe('ORGANIZE_SESSION_EXPIRED');
    });
  });

  it('regenerateCategories を直接呼んでも破綻しない(apply 後の整合性スモーク)', async () => {
    const root = await mkProject();
    await addNote(root, 'alpha', 'a', { categories: ['beta'] });
    const { sessionId, proposals } = await scan(root);
    const fix = proposals.find((p) => p.kind === 'fix-frontmatter')!;
    await organizeApplyModule.handler(
      { sessionId, proposalIds: [fix.proposalId], label: 'organize', confirmedDestructive: [] },
      ctx(root),
    );
    await expect(regenerateCategories(root)).resolves.toBeDefined();
  });
});
