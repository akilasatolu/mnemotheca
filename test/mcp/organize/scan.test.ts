import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ORGANIZE_HEURISTICS_VERSION } from '../../../src/core/organize-config.js';
import type { Frontmatter } from '../../../src/core/frontmatter.js';
import { noteAbsPathForCategory, writeNote } from '../../../src/core/note.js';
import { mnemothecaPaths, vaultPaths } from '../../../src/core/paths.js';
import { scanVault } from '../../../src/mcp/organize/scan.js';
import { readSession } from '../../../src/mcp/organize/session.js';
import { makeProject } from '../../helpers/project.js';

function sessionFile(root: string): string {
  return mnemothecaPaths(root).organizeSessionJson;
}

async function writeRawSession(root: string, obj: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(sessionFile(root)), { recursive: true });
  await fs.promises.writeFile(
    sessionFile(root),
    typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2),
    'utf8',
  );
}

function applyingSession(): Record<string, unknown> {
  return {
    v: 1,
    sessionId: 'org-prev',
    scannedAt: '2026-09-02T09:00:00.000Z',
    proposals: [],
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    applying: true,
    snapshotId: 'organize-1756800000000',
  };
}

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

let seq = 0;
function fm(overrides: Partial<Frontmatter> = {}): Frontmatter {
  seq += 1;
  return {
    id: `20260901T0930${String(seq).padStart(6, '0')}`,
    title: 'ノート',
    categories: ['misc'],
    tags: [],
    created: '2026-09-01T09:30:00+09:00',
    updated: '2026-09-01T09:30:00+09:00',
    summary: '',
    ...overrides,
  };
}

async function addNote(
  root: string,
  category: string,
  slug: string,
  overrides: Partial<Frontmatter>,
  body = '## 要約\n\n本文\n',
): Promise<void> {
  const abs = noteAbsPathForCategory(root, category, slug);
  await writeNote(abs, fm({ categories: [category], title: slug, ...overrides }), body);
}

function listVaultFiles(root: string): { rel: string; mtimeMs: number }[] {
  const vaultRoot = vaultPaths(root).root;
  const out: { rel: string; mtimeMs: number }[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push({ rel: path.relative(vaultRoot, full), mtimeMs: fs.statSync(full).mtimeMs });
    }
  };
  walk(vaultRoot);
  return out.sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

describe('scanVault (§8-N scan / §13-11)', () => {
  it('空 vault → 提案 0・parseErrors 0・エラーなし', async () => {
    const root = await mkProject();
    const preview = await scanVault(root);
    expect(preview.proposals).toEqual([]);
    expect(preview.parseErrors).toEqual([]);
    expect(preview.noteCount).toBe(0);
  });

  it('preview に heuristicsVersion(= ORGANIZE_HEURISTICS_VERSION)を含む', async () => {
    const root = await mkProject();
    const preview = await scanVault(root);
    expect(preview.heuristicsVersion).toBe(ORGANIZE_HEURISTICS_VERSION);
    expect(typeof preview.scannedAt).toBe('string');
  });

  it('dry-run で vault 内のファイル数・mtime が不変', async () => {
    const root = await mkProject();
    await addNote(root, 'ml', 'a', {});
    await addNote(root, 'ml', 'b', {});
    await addNote(root, '_uncategorized', 'c', {});

    const before = listVaultFiles(root);
    await scanVault(root);
    await scanVault(root);
    const after = listVaultFiles(root);

    expect(after).toEqual(before);
  });

  it('同名タイトル 2 件 → duplicate 提案(proposalId 採番)', async () => {
    const root = await mkProject();
    await addNote(root, 'a', 'x', { title: 'AWS MCP 実現可能性' });
    await addNote(root, 'b', 'y', { title: 'aws-mcp（実現可能性）' });

    const preview = await scanVault(root);
    const dup = preview.proposals.filter((p) => p.kind === 'duplicate');
    expect(dup.length).toBeGreaterThanOrEqual(1);
    expect(dup[0]?.proposalId).toBe('duplicate-1');
    expect(dup.some((p) => p.evidence.reason === 'title-exact')).toBe(true);
  });

  it('本文 sha256 一致 2 件 → duplicate 提案', async () => {
    const root = await mkProject();
    const body = '## 要約\n\nまったく同じ本文です\n';
    await addNote(root, 'a', 'x', { title: 'T1' }, body);
    await addNote(root, 'b', 'y', { title: 'T2' }, body.replace(/\n/g, '\n\n'));

    const preview = await scanVault(root);
    expect(preview.proposals.some((p) => p.kind === 'duplicate' && p.evidence.reason === 'body-hash')).toBe(
      true,
    );
  });

  it('_uncategorized のノートが既存カテゴリと近い → move-uncategorized 提案(候補カテゴリ付き)', async () => {
    const root = await mkProject();
    const body = '## 詳細\n\n機械学習 モデル の 評価 指標 精度 再現率 について\n';
    await addNote(root, 'ml', 'a', {}, body);
    await addNote(root, 'ml', 'b', {}, body);
    await addNote(root, '_uncategorized', 'c', {}, body);

    const preview = await scanVault(root);
    const move = preview.proposals.filter((p) => p.kind === 'move-uncategorized');
    expect(move).toHaveLength(1);
    expect(move[0]?.targets).toEqual(['knowledge/_uncategorized/c.md']);
    expect(move[0]?.evidence.candidateCategory).toBe('ml');
  });

  it('updated が staleDays 以前 → stale-content フラグ', async () => {
    const root = await mkProject();
    await addNote(root, 'a', 'old', { updated: '2023-01-01T00:00:00+09:00' });

    const preview = await scanVault(root, { now: Date.parse('2026-09-03T00:00:00+09:00') });
    const stale = preview.proposals.filter((p) => p.kind === 'stale-content');
    expect(stale).toHaveLength(1);
    expect(stale[0]?.targets).toEqual(['knowledge/a/old.md']);
  });

  it('壊れた frontmatter のノートは parseErrors に載せ、全体は落ちない', async () => {
    const root = await mkProject();
    await addNote(root, 'a', 'good', {});
    const broken = noteAbsPathForCategory(root, 'a', 'broken');
    await fs.promises.writeFile(broken, '---\ntitle: [unterminated\n---\n本文', 'utf8');

    const preview = await scanVault(root);
    expect(preview.parseErrors.some((e) => e.relPath === 'knowledge/a/broken.md')).toBe(true);
    expect(preview.noteCount).toBe(1);
  });

  it('日付プレフィックスファイル → split-file 提案', async () => {
    const root = await mkProject();
    await addNote(root, 'journal', '2026-09-01-daily', {});
    const preview = await scanVault(root);
    const sf = preview.proposals.filter((p) => p.kind === 'split-file');
    expect(sf).toHaveLength(1);
    expect(sf[0]?.targets).toEqual(['knowledge/journal/2026-09-01-daily.md']);
    expect(sf[0]?.proposalId).toBe('split-file-1');
  });

  it('categories[0] が実ディレクトリと不一致 → fix-frontmatter 提案', async () => {
    const root = await mkProject();
    // ファイルは knowledge/a/ に置くが frontmatter categories は ['b']
    await addNote(root, 'a', 'mismatch', { categories: ['b'] });
    const preview = await scanVault(root);
    const ff = preview.proposals.filter((p) => p.kind === 'fix-frontmatter');
    expect(ff).toHaveLength(1);
    expect(ff[0]?.evidence).toMatchObject({ declaredCategory: 'b', dirCategory: 'a' });
  });

  it('crash 復帰: applying:true の session がある → proposals 空 + pendingRecovery、スキャンしない', async () => {
    const root = await mkProject();
    await addNote(root, 'a', 'x', { title: 'AWS MCP' });
    await addNote(root, 'b', 'y', { title: 'AWS MCP' }); // 通常なら duplicate 提案が出る
    await writeRawSession(root, applyingSession());

    const preview = await scanVault(root);
    expect(preview.proposals).toEqual([]);
    expect(preview.pendingRecovery).toEqual({
      snapshotId: 'organize-1756800000000',
      since: '2026-09-02T09:00:00.000Z',
    });
    expect(preview.sessionId).toBe('org-prev');
  });

  it('crash 復帰: discardPendingRecovery:true → 破棄して通常スキャン、session は applying:false へ', async () => {
    const root = await mkProject();
    await addNote(root, 'a', 'x', { title: 'AWS MCP' });
    await addNote(root, 'b', 'y', { title: 'AWS MCP' });
    await writeRawSession(root, applyingSession());

    const preview = await scanVault(root, { discardPendingRecovery: true });
    expect(preview.pendingRecovery).toBeNull();
    expect(preview.proposals.some((p) => p.kind === 'duplicate')).toBe(true);
    const { session } = await readSession(root);
    expect(session?.applying).toBe(false);
    expect(session?.snapshotId).toBeNull();
  });

  it('crash 復帰で無限ループしない: session ファイルを消せば次の scan は通常提案を返す', async () => {
    const root = await mkProject();
    await addNote(root, 'a', 'x', { title: 'AWS MCP' });
    await addNote(root, 'b', 'y', { title: 'AWS MCP' });
    await writeRawSession(root, applyingSession());

    const first = await scanVault(root);
    expect(first.pendingRecovery).not.toBeNull();

    // mnemo_organize_undo 相当: applying:true の session ファイルを削除
    await fs.promises.rm(sessionFile(root), { force: true });

    const second = await scanVault(root);
    expect(second.pendingRecovery).toBeNull();
    expect(second.proposals.some((p) => p.kind === 'duplicate')).toBe(true);
  });

  it('organize-session.json が壊れている → .corrupt-<ts> 退避 + 新規スキャン成功', async () => {
    const root = await mkProject();
    await addNote(root, 'a', 'x', {});
    await writeRawSession(root, '{ this is not json');

    const preview = await scanVault(root);
    expect(preview.pendingRecovery).toBeNull();
    expect(preview.sessionId).toMatch(/^org-/);
    expect(preview.noteCount).toBe(1);

    const indexDir = mnemothecaPaths(root).indexDir;
    const retired = fs.readdirSync(indexDir).filter((f) => f.startsWith('organize-session.json.corrupt-'));
    expect(retired).toHaveLength(1);
    // 新規セッションが書けている
    const { session } = await readSession(root);
    expect(session?.sessionId).toBe(preview.sessionId);
  });

  it('通常スキャン完了時に organize-session.json が書かれる(proposals 永続化)', async () => {
    const root = await mkProject();
    await addNote(root, 'a', 'x', { title: 'AWS MCP' });
    await addNote(root, 'b', 'y', { title: 'AWS MCP' });

    const preview = await scanVault(root);
    const { session } = await readSession(root);
    expect(session).not.toBeNull();
    expect(session?.sessionId).toBe(preview.sessionId);
    expect(session?.applying).toBe(false);
    expect(session?.proposals.length).toBe(preview.proposals.length);
    expect(Date.parse(session?.expiresAt ?? '')).toBeGreaterThan(Date.parse(session?.scannedAt ?? ''));
  });

  it('scope 相当: onlyCategory 指定で対象を 1 カテゴリに絞る', async () => {
    const root = await mkProject();
    await addNote(root, 'a', 'old1', { updated: '2023-01-01T00:00:00+09:00' });
    await addNote(root, 'b', 'old2', { updated: '2023-01-01T00:00:00+09:00' });

    const preview = await scanVault(root, {
      now: Date.parse('2026-09-03T00:00:00+09:00'),
      onlyCategory: 'a',
    });
    expect(preview.noteCount).toBe(1);
    const stale = preview.proposals.filter((p) => p.kind === 'stale-content');
    expect(stale).toHaveLength(1);
    expect(stale[0]?.targets).toEqual(['knowledge/a/old1.md']);
  });
});
