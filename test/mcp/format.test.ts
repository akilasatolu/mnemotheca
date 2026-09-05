import { describe, expect, it, vi } from 'vitest';
import { ERROR_CODES } from '../../src/core/errors.js';
import {
  formatMnemoError,
  formatOrganizeApplyResult,
  formatOrganizePreview,
  formatShowResult,
  formatStorePlan,
  formatStoreResult,
} from '../../src/mcp/format.js';
import { tryElicit } from '../../src/mcp/elicit.js';

describe('formatStorePlan (§8-M dry-run text)', () => {
  it('renders numbered notes, new-category / collision notes, PII lines and the apply:true footer', () => {
    const text = formatStorePlan({
      willCreate: [
        {
          slug: 'aws-mcp-feasibility',
          path: 'knowledge/architecture/aws-mcp-feasibility.md',
          title: 'AWS 上での MCP 実現可能性',
          categorySegment: 'architecture',
          summary: '...',
          collision: 'none',
        },
        {
          slug: 'elicitation-support',
          path: 'knowledge/mcp/elicitation-support.md',
          title: 'MCP elicitation の対応状況',
          categorySegment: 'mcp',
          summary: '...',
          collision: 'none',
        },
        {
          slug: 'aws-mcp',
          path: 'knowledge/architecture/aws-mcp-2.md',
          title: 'AWS と MCP',
          categorySegment: 'architecture',
          summary: '...',
          collision: 'auto-number',
        },
      ],
      piiWarnings: [{ pattern: 'メールアドレス', count: 1 }],
      piiBlocks: [],
      newCategories: ['mcp'],
      totalApproxChars: 4200,
    });
    expect(text).toMatchInlineSnapshot(`
      "3 件のノートを保存予定です。
      1. knowledge/architecture/aws-mcp-feasibility.md — 「AWS 上での MCP 実現可能性」
      2. knowledge/mcp/elicitation-support.md — 「MCP elicitation の対応状況」(新規カテゴリ mcp を作成)
      3. knowledge/architecture/aws-mcp-2.md — 「AWS と MCP」 → 既存と同名のため別名(連番)で作成予定
      PII: メールアドレス 1 件 を検出(WARN、保存は続行)。
      クレデンシャル等の BLOCK はありません。
      合計およそ 4200 文字。
      この内容で保存してよろしければ、承認後に apply:true で再送してください。"
    `);
  });

  it('warns that apply will fail when a PII BLOCK is present', () => {
    const text = formatStorePlan({
      willCreate: [
        {
          slug: 'x',
          path: 'knowledge/misc/x.md',
          title: 'X',
          categorySegment: 'misc',
          summary: '...',
          collision: 'none',
        },
      ],
      piiWarnings: [],
      piiBlocks: [{ pattern: 'APIキー', noteSlug: 'x', masked: 'sk-****' }],
      newCategories: [],
      totalApproxChars: 100,
    });
    expect(text).toContain('PII BLOCK: APIキー(x: sk-****)。このままでは apply は失敗します。');
    expect(text).toContain('BLOCK を解消');
  });
});

describe('formatStoreResult (§8-M apply summary)', () => {
  it('lists created and appended paths', () => {
    const text = formatStoreResult({
      created: [
        { slug: 'a', path: 'knowledge/architecture/a.md', id: 'id-a' },
        { slug: 'b', path: 'knowledge/mcp/b.md', id: 'id-b' },
      ],
      appended: [{ slug: 'c', path: 'knowledge/architecture/c.md', id: 'id-c' }],
      categoriesRegenerated: true,
    });
    expect(text).toMatchInlineSnapshot(`
      "3 件保存しました:
      - knowledge/architecture/a.md
      - knowledge/mcp/b.md
      - knowledge/architecture/c.md(既存ファイルに追記)
      カテゴリ一覧を再生成しました。"
    `);
  });
});

describe('formatOrganizePreview (§8-N Before/After text)', () => {
  it('renders per-proposal Before/After, file ops, conflicts and the individual-approval footer', () => {
    const text = formatOrganizePreview(
      [
        {
          proposalId: 'move-uncategorized-1',
          kind: 'move-uncategorized',
          before: 'knowledge/_uncategorized/note.md',
          after: 'knowledge/mcp/note.md',
          fileOps: [
            { op: 'move', from: 'knowledge/_uncategorized/note.md', to: 'knowledge/mcp/note.md' },
          ],
        },
        {
          proposalId: 'merge-file-1',
          kind: 'merge-file',
          before: 'a.md, b.md',
          after: 'a.md(b.md を統合)',
          fileOps: [
            { op: 'merge-into', from: 'knowledge/x/b.md', to: 'knowledge/x/a.md' },
            { op: 'delete', from: 'knowledge/x/b.md' },
          ],
          conflicts: ['move-uncategorized-1 が同じファイルを移動'],
        },
      ],
      ['同一ファイル b.md に統合と移動が競合'],
    );
    expect(text).toMatchInlineSnapshot(`
      "[move-uncategorized-1] move-uncategorized
        Before: knowledge/_uncategorized/note.md
        After:  knowledge/mcp/note.md
        操作:
          - 移動: knowledge/_uncategorized/note.md → knowledge/mcp/note.md

      [merge-file-1] merge-file
        Before: a.md, b.md
        After:  a.md(b.md を統合)
        操作:
          - 統合: knowledge/x/b.md → knowledge/x/a.md
          - 削除: knowledge/x/b.md
        競合: move-uncategorized-1 が同じファイルを移動

      全体の競合:
        - 同一ファイル b.md に統合と移動が競合

      各提案を個別にユーザーへ提示し、承認されたものだけを mnemo_organize_apply に渡してください(削除・統合・カテゴリ名変更は confirmedDestructive にも列挙)。"
    `);
  });
});

describe('formatOrganizeApplyResult (§8-N apply summary)', () => {
  it('summarises moved / merged / deleted / frontmatter-fixed and adds the undo hint', () => {
    const text = formatOrganizeApplyResult({
      snapshot: 'organize-20260903-120000',
      applied: ['move-uncategorized-1', 'fix-frontmatter-2'],
      summary: {
        dirsCreated: ['knowledge/mcp'],
        dirsRemoved: [],
        filesMoved: [{ from: 'knowledge/_uncategorized/note.md', to: 'knowledge/mcp/note.md' }],
        filesMerged: [],
        filesDeleted: [],
        frontmatterFixed: ['knowledge/mcp/note.md', 'knowledge/x/a.md'],
      },
    });
    expect(text).toMatchInlineSnapshot(`
      "整理を適用しました(スナップショット organize-20260903-120000)。
      適用した提案: move-uncategorized-1, fix-frontmatter-2
      - 移動: 1 件
          knowledge/_uncategorized/note.md → knowledge/mcp/note.md
      - frontmatter 修正: 2 件
      - 作成したディレクトリ: knowledge/mcp
      元に戻すには mnemo_organize_undo({ snapshot: "organize-20260903-120000" }) を実行してください。"
    `);
  });
});

describe('formatShowResult (§8-O URL guidance)', () => {
  it('confirms the browser was opened', () => {
    expect(
      formatShowResult({ url: 'http://127.0.0.1:7777/?t=abc', started: true, browserOpened: true, port: 7777 }),
    ).toBe('ブラウザで UI を開きました: http://127.0.0.1:7777/?t=abc');
  });
  it('asks the user to open the URL manually when the browser could not be opened', () => {
    expect(
      formatShowResult({ url: 'http://127.0.0.1:7777/?t=abc', started: true, browserOpened: false, port: 7777 }),
    ).toBe(
      'UI サーバーは起動しています。ブラウザを自動で開けなかったので次の URL を開いてください: http://127.0.0.1:7777/?t=abc',
    );
  });
});

describe('formatMnemoError (§12-1 error text)', () => {
  it('renders description + 対処 for a representative code', () => {
    expect(formatMnemoError({ code: 'LOCK_TIMEOUT' })).toMatchInlineSnapshot(`
      "別の保存/整理処理が実行中です。
      対処: 数秒待ってから再試行してください。"
    `);
  });

  it('includes details.detail and details.snapshotDir when present', () => {
    const text = formatMnemoError({
      code: 'SNAPSHOT_FAILED',
      details: { detail: 'restoreSnapshot が失敗しました', snapshotDir: '/x/.mnemotheca/snapshots/s1' },
    });
    expect(text).toContain('restoreSnapshot が失敗しました');
    expect(text).toContain('スナップショット: /x/.mnemotheca/snapshots/s1');
    expect(text).toContain('対処:');
  });

  it('has a non-empty description + action for every ErrorCode (all 27)', () => {
    for (const code of ERROR_CODES) {
      const text = formatMnemoError({ code });
      expect(text.length).toBeGreaterThan(0);
      expect(text).toContain('対処:');
    }
  });
});

describe('tryElicit (§8-Q / §13-11b no-op)', () => {
  it('returns null without throwing when ctx.mcpReq.elicitInput is absent', async () => {
    await expect(tryElicit({ mcpReq: {} }, { type: 'object' })).resolves.toBeNull();
    await expect(tryElicit({}, { type: 'object' })).resolves.toBeNull();
    await expect(tryElicit(undefined, { type: 'object' })).resolves.toBeNull();
  });

  it('delegates to elicitInput when the client supports it', async () => {
    const elicitInput = vi.fn().mockResolvedValue({ action: 'accept', content: { ok: true } });
    const out = await tryElicit({ mcpReq: { elicitInput } }, { type: 'object' });
    expect(out).toEqual({ action: 'accept', content: { ok: true } });
    expect(elicitInput).toHaveBeenCalledWith({ type: 'object' });
  });

  it('swallows a throwing elicitInput and returns null', async () => {
    const elicitInput = vi.fn().mockRejectedValue(new Error('not supported'));
    await expect(tryElicit({ mcpReq: { elicitInput } }, {})).resolves.toBeNull();
  });
});
