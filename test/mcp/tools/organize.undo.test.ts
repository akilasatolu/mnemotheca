// test/mcp/tools/organize.undo.test.ts — 設計書 §8-N undo / §13-11。
//
// organizeUndoModule(mnemo_organize_undo)の単体テスト:
//   - 通常 undo: 直近スナップショット復元・fileCount 一致・vault が apply 前へ戻る
//   - snapshot 省略 → 直近スナップショットを使う
//   - スナップショットが 1 件も無い → SNAPSHOT_FAILED
//   - 正規復帰(step4): applying:true + snapshotId 残置状態を作り、
//       undo({ snapshot: pendingRecovery.snapshotId }) → vault 復元 + organize-session.json 削除
//       → 以後の scan は pendingRecovery:null + 通常提案(無限ループしない)
//   - 通常 undo は session を触らない: 別 sessionId の session がある状態で undo → その session は残る

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { isMnemoError } from '../../../src/core/errors.js';
import type { Frontmatter } from '../../../src/core/frontmatter.js';
import { noteAbsPathForCategory, writeNote } from '../../../src/core/note.js';
import { vaultPaths } from '../../../src/core/paths.js';
import * as snapshotMod from '../../../src/core/snapshot.js';
import { listSnapshots } from '../../../src/core/snapshot.js';
import { scanVault } from '../../../src/mcp/organize/scan.js';
import { buildSession, readSession, writeSession } from '../../../src/mcp/organize/session.js';
import {
  organizeApplyModule,
  organizeScanModule,
  organizeUndoModule,
} from '../../../src/mcp/tools/organize.js';
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
  await writeNote(
    noteAbsPathForCategory(root, category, slug),
    fm,
    opts.body ?? `## 要約\n\n${slug} 本文\n`,
  );
  return `knowledge/${category}/${slug}.md`;
}

function readRaw(root: string, rel: string): string {
  return fs.readFileSync(path.join(vaultPaths(root).root, ...rel.split('/')), 'utf8');
}

interface ScanSC {
  sessionId: string;
  proposals: { proposalId: string; kind: string; destructiveness: string }[];
}

async function scan(root: string): Promise<ScanSC> {
  const res = await organizeScanModule.handler({ apply: false, scope: 'all' }, ctx(root));
  return res.structuredContent as ScanSC;
}

interface UndoSC {
  restored: boolean;
  snapshot: string;
  fileCount: number;
  sessionCleared: boolean;
}

/** alpha ノートの categories を間違えて保存 → scan → fix-frontmatter を apply。 */
async function applyFixFrontmatter(root: string): Promise<{ snapshot: string }> {
  await addNote(root, 'alpha', 'mismatch', { categories: ['beta'], title: 'ミスマッチ' });
  const { sessionId, proposals } = await scan(root);
  const fix = proposals.find((p) => p.kind === 'fix-frontmatter');
  if (fix === undefined) throw new Error('fix-frontmatter proposal not found');
  const res = await organizeApplyModule.handler(
    { sessionId, proposalIds: [fix.proposalId], label: 'organize', confirmedDestructive: [] },
    ctx(root),
  );
  const sc = res.structuredContent as { snapshot: string };
  return { snapshot: sc.snapshot };
}

describe('organizeUndoModule (mnemo_organize_undo — §8-N / §13-11)', () => {
  it('module メタ情報: name / inputSchema あり', () => {
    expect(organizeUndoModule.name).toBe('mnemo_organize_undo');
    expect(organizeUndoModule.config.inputSchema).toBeDefined();
  });

  it('通常 undo: 直近 snapshot 復元・fileCount 一致・vault が apply 前へ戻る', async () => {
    const root = await mkProject();
    const { snapshot } = await applyFixFrontmatter(root);

    // apply 後: categories は alpha へ是正されている
    expect(readRaw(root, 'knowledge/alpha/mismatch.md')).toMatch(/categories:\s*\[\s*alpha\s*\]/);

    const info = (await listSnapshots(root)).find((s) => s.id === snapshot);
    expect(info).toBeDefined();

    const res = await organizeUndoModule.handler({ snapshot }, ctx(root));
    const sc = res.structuredContent as UndoSC;

    expect(sc.restored).toBe(true);
    expect(sc.snapshot).toBe(snapshot);
    expect(sc.fileCount).toBe(info!.fileCount);
    expect(sc.sessionCleared).toBe(false);

    // vault は apply 前(categories: [beta])へ戻っている
    expect(readRaw(root, 'knowledge/alpha/mismatch.md')).toMatch(/categories:\s*\[\s*beta\s*\]/);
    expect((res.content[0] as { text: string }).text).toContain(snapshot);
  });

  it('snapshot 省略 → 直近スナップショットを復元する', async () => {
    const root = await mkProject();
    const { snapshot } = await applyFixFrontmatter(root);

    const res = await organizeUndoModule.handler({}, ctx(root));
    const sc = res.structuredContent as UndoSC;
    expect(sc.snapshot).toBe(snapshot);
    expect(readRaw(root, 'knowledge/alpha/mismatch.md')).toMatch(/categories:\s*\[\s*beta\s*\]/);
  });

  it('スナップショットが無い → SNAPSHOT_FAILED', async () => {
    const root = await mkProject();
    await addNote(root, 'alpha', 'a');
    const err = await organizeUndoModule.handler({}, ctx(root)).catch((e: unknown) => e);
    expect(isMnemoError(err)).toBe(true);
    expect((err as { code: string }).code).toBe('SNAPSHOT_FAILED');
  });

  it('正規復帰: applying:true + snapshotId 残置 → undo で vault 復元 + session 削除 + 以後の scan は通常提案', async () => {
    const root = await mkProject();
    await addNote(root, 'alpha', 'mismatch', { categories: ['beta'], title: 'ミスマッチ' });
    const { sessionId, proposals } = await scan(root);
    const fix = proposals.find((p) => p.kind === 'fix-frontmatter')!;

    // apply を「finalize 直前で crash + restore も失敗」させ、applying:true + snapshotId を残置する。
    vi.spyOn(snapshotMod, 'finalizeSnapshotManifest').mockRejectedValue(new Error('crash'));
    vi.spyOn(snapshotMod, 'restoreSnapshot').mockRejectedValue(new Error('restore failed'));

    const err = await organizeApplyModule
      .handler(
        { sessionId, proposalIds: [fix.proposalId], label: 'organize', confirmedDestructive: [] },
        ctx(root),
      )
      .catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe('SNAPSHOT_FAILED');

    vi.restoreAllMocks();

    const { session: crashed } = await readSession(root);
    expect(crashed!.applying).toBe(true);
    const snapshotId = crashed!.snapshotId!;
    expect(snapshotId.length).toBeGreaterThan(0);

    // scan 契機は pendingRecovery を返す(スキャンしない)
    const pre = await scanVault(root);
    expect(pre.pendingRecovery).not.toBeNull();
    expect(pre.pendingRecovery!.snapshotId).toBe(snapshotId);

    // 正規復帰: undo({ snapshot: pendingRecovery.snapshotId })
    const res = await organizeUndoModule.handler({ snapshot: snapshotId }, ctx(root));
    const sc = res.structuredContent as UndoSC;
    expect(sc.restored).toBe(true);
    expect(sc.sessionCleared).toBe(true);

    // vault は apply 前へ戻っている
    expect(readRaw(root, 'knowledge/alpha/mismatch.md')).toMatch(/categories:\s*\[\s*beta\s*\]/);

    // organize-session.json は削除された
    const { session: after } = await readSession(root);
    expect(after).toBeNull();

    // 以後の scan は pendingRecovery:null + 通常提案(無限ループしない)
    const rescan = await scanVault(root);
    expect(rescan.pendingRecovery).toBeNull();
    expect(rescan.proposals.some((p) => p.kind === 'fix-frontmatter')).toBe(true);
  });

  it('通常 undo は session を触らない: 別 sessionId の session は消さない', async () => {
    const root = await mkProject();
    const { snapshot } = await applyFixFrontmatter(root);

    // apply 成功で session は消えている。ここで別 organize の新しい session を用意する
    // (applying:true・別 snapshotId — undo 対象と一致しない)。
    const other = buildSession('org-other-session', new Date().toISOString(), []);
    await writeSession(root, { ...other, applying: true, snapshotId: 'some-other-snap-999' });

    const res = await organizeUndoModule.handler({ snapshot }, ctx(root));
    expect((res.structuredContent as UndoSC).sessionCleared).toBe(false);

    // 別 sessionId の session は残っている
    const { session } = await readSession(root);
    expect(session).not.toBeNull();
    expect(session!.sessionId).toBe('org-other-session');
    expect(session!.applying).toBe(true);
  });
});
