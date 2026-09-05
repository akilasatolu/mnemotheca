// test/e2e/clone-recovery.test.ts — 設計 §13-16 git clone 復旧。
//
// store でノートを数件作る → simulateCloneState(.mnemotheca/index と snapshots を削除)→
// buildIndex(= reindex 相当)→ GET /api/search・/api/notes の件数が clone 前と一致。
// resolveProjectRoot が index 不在でも成功すること。

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mnemothecaPaths } from '../../src/core/paths.js';
import { resolveProjectRoot } from '../../src/core/paths.js';
import { buildIndex } from '../../src/core/search.js';
import { __resetStoreDryRunMemory } from '../../src/mcp/tools/store.js';
import { simulateCloneState } from '../helpers/project.js';
import {
  buildApp,
  callTool,
  cleanupRoots,
  getJson,
  makeTrackedProject,
  sc,
  storeNotes,
} from '../helpers/e2e.js';

const savedEnv = process.env.MNEMO_PROJECT;

beforeEach(() => {
  __resetStoreDryRunMemory();
  delete process.env.MNEMO_PROJECT;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.MNEMO_PROJECT;
  else process.env.MNEMO_PROJECT = savedEnv;
  cleanupRoots();
});

interface NotesListBody {
  total: number;
}
interface SearchBody {
  total: number;
  results: { path: string }[];
}

describe('§13-16 clone-recovery: index / snapshots 消失後に reindex で件数一致', () => {
  it('simulateCloneState → buildIndex → 一覧・検索の件数が clone 前と一致', async () => {
    const root = await makeTrackedProject();
    await storeNotes(root, [
      { slug: 'note-one', title: 'ノート 1', targetDir: 'architecture' },
      { slug: 'note-two', title: 'ノート 2', targetDir: 'architecture' },
      { slug: 'note-three', title: 'ノート 3(検索対象)', targetDir: 'search' },
      { slug: 'note-four', title: 'ノート 4', targetDir: 'mcp' },
    ]);
    await buildIndex(root);

    const appBefore = buildApp(root);
    const listBefore = await getJson<NotesListBody>(appBefore, '/api/notes');
    const searchBefore = await getJson<SearchBody>(
      appBefore,
      '/api/search?q=' + encodeURIComponent('ノート'),
    );
    expect(listBefore.body.total).toBe(4);
    expect(searchBefore.body.total).toBe(4);

    // ── clone 直後を再現(node_modules / index / snapshots 消滅、config.json と vault は残る)──
    simulateCloneState(root);
    expect(fs.existsSync(mnemothecaPaths(root).indexDir)).toBe(false);
    expect(fs.existsSync(path.join(root, '.mnemotheca', 'config.json'))).toBe(true);

    // resolveProjectRoot は index 不在でも成功する(config.json のみが条件)。
    expect(resolveProjectRoot({ startDir: root })).toBe(fs.realpathSync.native(root));

    // ── npm install(モック。node_modules/mnemo/dist/ が復元される)+ reindex 相当 ──
    await fs.promises.mkdir(path.join(root, 'node_modules', 'mnemo', 'dist', 'cli'), { recursive: true });
    await fs.promises.mkdir(path.join(root, 'node_modules', 'mnemo', 'dist', 'mcp'), { recursive: true });
    await fs.promises.writeFile(
      path.join(root, 'node_modules', 'mnemo', 'dist', 'cli', 'index.js'),
      '// dummy cli entry\n',
    );
    await fs.promises.writeFile(
      path.join(root, 'node_modules', 'mnemo', 'dist', 'mcp', 'index.js'),
      '// dummy mcp entry\n',
    );
    await buildIndex(root);

    const appAfter = buildApp(root);
    const listAfter = await getJson<NotesListBody>(appAfter, '/api/notes');
    const searchAfter = await getJson<SearchBody>(
      appAfter,
      '/api/search?q=' + encodeURIComponent('ノート'),
    );
    expect(listAfter.body.total).toBe(4);
    expect(searchAfter.body.total).toBe(4);

    // MCP 側(list_categories)から見た総ノート数も一致。
    const cats = sc<{ totalNotes: number }>(
      await callTool('mnemo_list_categories', {}, root),
    );
    expect(cats.totalNotes).toBe(4);
  });

  it('index 不在でも mnemo_get_vault_info / organize scan が縮退せず動く', async () => {
    const root = await makeTrackedProject();
    await storeNotes(root, [
      { slug: 'a', title: 'A', targetDir: 'architecture' },
      { slug: 'b', title: 'B', targetDir: 'architecture' },
    ]);
    simulateCloneState(root);

    const info = sc<{ noteCount: number; serverRunning: boolean }>(
      await callTool('mnemo_get_vault_info', {}, root),
    );
    expect(info.noteCount).toBe(2);
    expect(info.serverRunning).toBe(false);

    const scan = sc<{ noteCount: number }>(
      await callTool('mnemo_organize_scan', { apply: false, scope: 'all' }, root),
    );
    expect(scan.noteCount).toBe(2);
  });
});
