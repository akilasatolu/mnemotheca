// test/e2e/portability.test.ts — 設計 §13-16 ポータブル性。
//
// projectRoot を fs.cp で別パスへ複製 → 新パスで resolveProjectRoot / createApp が動く。
// config.json に絶対パスが無いことを明示 assert。projectHash が新旧で異なる
// (ランタイムスロット分離)。MCP サーバー起点(深い node_modules)からの projectRoot 解決も確認。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  findConfigAnchor,
  projectHash,
  resolveProjectRoot,
} from '../../src/core/paths.js';
import { __resetStoreDryRunMemory } from '../../src/mcp/tools/store.js';
import {
  buildApp,
  cleanupRoots,
  getJson,
  makeTrackedProject,
  storeNotes,
  trackRoot,
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

/** node_modules ごとの丸コピーは重いので、`.mnemotheca` + `vault` + ダミー node_modules マーカーで代用。 */
async function copyProject(src: string): Promise<string> {
  const dest = trackRoot(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mnemo-copy-')));
  for (const rel of ['.mnemotheca', 'vault']) {
    await fs.promises.cp(path.join(src, rel), path.join(dest, rel), { recursive: true });
  }
  // pnpm 風の深い node_modules に MCP エントリを置く(実体はダミーファイル)。
  const deep = path.join(
    dest,
    'node_modules',
    '.pnpm',
    'mnemo@9.9.9',
    'node_modules',
    'mnemo',
    'dist',
    'mcp',
  );
  await fs.promises.mkdir(deep, { recursive: true });
  await fs.promises.writeFile(path.join(deep, 'index.js'), '// dummy mcp entry\n');
  // doctor が見るマーカー(node_modules/mnemo への npm install 方式)。
  await fs.promises.mkdir(path.join(dest, 'node_modules', 'mnemo', 'dist', 'cli'), { recursive: true });
  await fs.promises.mkdir(path.join(dest, 'node_modules', 'mnemo', 'dist', 'mcp'), { recursive: true });
  await fs.promises.writeFile(path.join(dest, 'node_modules', 'mnemo', 'dist', 'cli', 'index.js'), '// dummy cli entry\n');
  await fs.promises.writeFile(path.join(dest, 'node_modules', 'mnemo', 'dist', 'mcp', 'index.js'), '// dummy mcp entry\n');
  return dest;
}

describe('§13-16 portability: cp した先で動く / config に絶対パス無し / projectHash 分離', () => {
  it('config.json は {v,createdAt,updatedAt} のみで絶対パスを含まない', async () => {
    const root = await makeTrackedProject();
    const raw = fs.readFileSync(path.join(root, '.mnemotheca', 'config.json'), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    expect(Object.keys(parsed).sort()).toEqual(['createdAt', 'updatedAt', 'v'].sort());
    // 文字列値のいずれにもパス区切りを含まない(絶対パスが紛れ込んでいない)。
    for (const v of Object.values(parsed)) {
      if (typeof v === 'string') {
        expect(v.includes('/')).toBe(false);
        expect(v.includes(path.sep)).toBe(false);
      }
    }
    expect(raw.includes(root)).toBe(false);
    expect(raw.includes(os.tmpdir())).toBe(false);
  });

  it('cp 先で resolveProjectRoot / createApp / 検索が動き、projectHash が新旧で異なる', async () => {
    const src = await makeTrackedProject();
    await storeNotes(src, [
      { slug: 'portable-note', title: 'ポータブルなノート', targetDir: 'architecture' },
      { slug: 'second-note', title: '2 番目のノート', targetDir: 'mcp' },
    ]);

    const dest = await copyProject(src);

    // resolveProjectRoot: 新パス直下からも、深い node_modules 起点(MCP サーバー起点)からも解決できる。
    expect(resolveProjectRoot({ startDir: dest })).toBe(fs.realpathSync.native(dest));
    const deepStart = path.join(
      dest,
      'node_modules',
      '.pnpm',
      'mnemo@9.9.9',
      'node_modules',
      'mnemo',
      'dist',
      'mcp',
    );
    expect(findConfigAnchor(deepStart)).toBe(fs.realpathSync.native(dest));

    // projectHash は realpath 基準で再計算されるのでスロットが分離される。
    expect(projectHash(dest)).not.toBe(projectHash(src));

    // createApp が新パスで動く(vault を読んで一覧・検索が返る)。
    const app = buildApp(dest);
    const list = await getJson<{ total: number }>(app, '/api/notes');
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(2);

    const search = await getJson<{ results: { path: string }[] }>(
      app,
      '/api/search?q=' + encodeURIComponent('ポータブル'),
    );
    expect(search.status).toBe(200);
    expect(search.body.results.map((r) => r.path)).toContain('knowledge/architecture/portable-note.md');

    const healthz = await app.request('/healthz');
    const hz = (await healthz.json()) as { projectRoot: string };
    expect(hz.projectRoot).toBe(dest);
  });
});
