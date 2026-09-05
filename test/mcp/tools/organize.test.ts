import fs from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { isMnemoError } from '../../../src/core/errors.js';
import type { Frontmatter } from '../../../src/core/frontmatter.js';
import { noteAbsPathForCategory, writeNote } from '../../../src/core/note.js';
import { mnemothecaPaths, vaultPaths } from '../../../src/core/paths.js';
import { ORGANIZE_HEURISTICS_VERSION } from '../../../src/core/organize-config.js';
import { withToolErrorBoundary } from '../../../src/mcp/server.js';
import { organizeScanModule } from '../../../src/mcp/tools/organize.js';
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
async function addNote(root: string, category: string, slug: string, title: string): Promise<void> {
  seq += 1;
  const fm: Frontmatter = {
    id: `20260901T0930${String(seq).padStart(6, '0')}`,
    title,
    categories: [category],
    tags: [],
    created: '2026-09-01T09:30:00+09:00',
    updated: '2026-09-01T09:30:00+09:00',
    summary: '',
  };
  await writeNote(noteAbsPathForCategory(root, category, slug), fm, '## 要約\n\n本文\n');
}

describe('organizeScanModule (mnemo_organize_scan — scan / §8-N)', () => {
  it('module メタ情報: name / inputSchema あり', () => {
    expect(organizeScanModule.name).toBe('mnemo_organize_scan');
    expect(organizeScanModule.config.inputSchema).toBeDefined();
  });

  it('空 vault: structuredContent に heuristicsVersion を含み、text にバージョン表記', async () => {
    const root = await mkProject();
    const res = await organizeScanModule.handler({ apply: false, scope: 'all' }, ctx(root));
    expect(res.isError).toBeUndefined();
    const sc = res.structuredContent as Record<string, unknown>;
    expect(sc.heuristicsVersion).toBe(ORGANIZE_HEURISTICS_VERSION);
    expect(sc.proposals).toEqual([]);
    expect((res.content[0] as { text: string }).text).toContain(`v${ORGANIZE_HEURISTICS_VERSION}`);
  });

  it('提案が text と structuredContent の両方に proposalId 付きで現れる', async () => {
    const root = await mkProject();
    await addNote(root, 'a', 'x', 'AWS MCP 実現可能性');
    await addNote(root, 'b', 'y', 'aws-mcp（実現可能性）');

    const res = await organizeScanModule.handler({ apply: false, scope: 'all' }, ctx(root));
    const sc = res.structuredContent as { proposals: { proposalId: string; kind: string }[] };
    expect(sc.proposals.some((p) => p.kind === 'duplicate')).toBe(true);
    const dup = sc.proposals.find((p) => p.kind === 'duplicate');
    expect((res.content[0] as { text: string }).text).toContain(dup?.proposalId ?? 'NOPE');
  });

  it('vault が無い → MnemoError(VAULT_UNAVAILABLE) を投げる', async () => {
    const root = await mkProject();
    fs.rmSync(vaultPaths(root).root, { recursive: true, force: true });

    let caught: unknown;
    try {
      await organizeScanModule.handler({ apply: false, scope: 'all' }, ctx(root));
    } catch (e) {
      caught = e;
    }
    expect(isMnemoError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe('VAULT_UNAVAILABLE');
  });

  it('withToolErrorBoundary 経由だと vault 欠落は isError 結果になる', async () => {
    const root = await mkProject();
    fs.rmSync(vaultPaths(root).root, { recursive: true, force: true });

    const guarded = withToolErrorBoundary(organizeScanModule.handler);
    const res = await guarded({ apply: false, scope: 'all' }, ctx(root));
    expect(res.isError).toBe(true);
    expect((res.structuredContent as Record<string, unknown>).code).toBe('VAULT_UNAVAILABLE');
  });

  it('structuredContent に sessionId を含み、通常時は pendingRecovery:null', async () => {
    const root = await mkProject();
    await addNote(root, 'a', 'x', 'AWS MCP');
    await addNote(root, 'b', 'y', 'AWS MCP');
    const res = await organizeScanModule.handler({ apply: false, scope: 'all' }, ctx(root));
    const sc = res.structuredContent as Record<string, unknown>;
    expect(typeof sc.sessionId).toBe('string');
    expect((sc.sessionId as string).startsWith('org-')).toBe(true);
    expect(sc.pendingRecovery).toBeNull();
  });

  it('applying:true の session がある → proposals 空 + pendingRecovery を返す', async () => {
    const root = await mkProject();
    await addNote(root, 'a', 'x', 'AWS MCP');
    await addNote(root, 'b', 'y', 'AWS MCP');
    await fs.promises.writeFile(
      mnemothecaPaths(root).organizeSessionJson,
      JSON.stringify({
        v: 1,
        sessionId: 'org-prev',
        scannedAt: '2026-09-02T09:00:00.000Z',
        proposals: [],
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        applying: true,
        snapshotId: 'organize-123',
      }),
      'utf8',
    );

    const res = await organizeScanModule.handler({ apply: false, scope: 'all' }, ctx(root));
    const sc = res.structuredContent as Record<string, unknown>;
    expect(sc.proposals).toEqual([]);
    expect(sc.pendingRecovery).toEqual({ snapshotId: 'organize-123', since: '2026-09-02T09:00:00.000Z' });
    expect((res.content[0] as { text: string }).text).toContain('organize-123');

    // discardPendingRecovery:true で破棄ルート
    const res2 = await organizeScanModule.handler(
      { apply: false, scope: 'all', discardPendingRecovery: true },
      ctx(root),
    );
    const sc2 = res2.structuredContent as Record<string, unknown>;
    expect(sc2.pendingRecovery).toBeNull();
    expect((sc2.proposals as unknown[]).length).toBeGreaterThan(0);
  });

  it('dry-run: ハンドラ実行後も vault 内ファイルが不変', async () => {
    const root = await mkProject();
    await addNote(root, 'a', 'x', 'タイトル A');
    const vaultRoot = vaultPaths(root).root;
    const snap = (dir: string): string[] =>
      fs
        .readdirSync(dir, { recursive: true })
        .map((f) => String(f))
        .sort();
    const before = snap(vaultRoot);
    await organizeScanModule.handler({ apply: false, scope: 'all' }, ctx(root));
    expect(snap(vaultRoot)).toEqual(before);
  });
});
