import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MiniSearch from 'minisearch';
import { isMnemoError } from '../../src/core/errors.js';
import type { Frontmatter } from '../../src/core/frontmatter.js';
import { noteAbsPathForCategory, noteRelPath, writeNote } from '../../src/core/note.js';
import { mnemothecaPaths } from '../../src/core/paths.js';
import {
  applyDelta,
  buildIndex,
  buildMiniSearchOptions,
  isQueryTooShort,
  loadIndex,
  search,
  searchableQueryTerms,
  syncIndex,
} from '../../src/core/search.js';
import { makeProject } from '../helpers/project.js';

const roots: string[] = [];

async function mkProject(): Promise<string> {
  const root = await makeProject();
  roots.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length > 0) {
    const d = roots.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `20260901T093015${String(idCounter).padStart(3, '0')}ab`;
}

function fm(overrides: Partial<Frontmatter> = {}): Frontmatter {
  return {
    id: nextId(),
    title: 'タイトル',
    categories: ['architecture'],
    tags: ['aws', 'mcp'],
    created: '2026-09-01T09:30:15+09:00',
    updated: '2026-09-01T09:30:15+09:00',
    summary: '要約テキスト',
    source: 'claude-desktop',
    ...overrides,
  };
}

/** knowledge/<cat>/<slug>.md を書き、vault 相対パスを返す。 */
async function addNote(
  root: string,
  cat: string,
  slug: string,
  overrides: Partial<Frontmatter>,
  body: string,
): Promise<string> {
  const abs = noteAbsPathForCategory(root, cat, slug);
  await writeNote(abs, fm({ categories: [cat], ...overrides }), body);
  return noteRelPath(root, abs);
}

function bumpMtime(abs: string, secondsAhead = 5): void {
  const t = new Date(Date.now() + secondsAhead * 1000);
  fs.utimesSync(abs, t, t);
}

// ---------------------------------------------------------------------------
// buildIndex(§13-8)
// ---------------------------------------------------------------------------

describe('buildIndex() (§6-3 / §13-8)', () => {
  it('docCount が実ノート数と一致し、meta.docs に mtime を記録する', async () => {
    const root = await mkProject();
    await addNote(root, 'architecture', 'a', {}, '## 詳細\n\n機械学習の応用\n');
    await addNote(root, 'architecture', 'b', {}, '## 詳細\n\nモデルコンテキストプロトコル\n');
    await addNote(root, 'ml', 'c', { categories: ['ml'] }, '## 詳細\n\n深層学習の基礎\n');

    const h = await buildIndex(root);

    expect(h.meta.docCount).toBe(3);
    expect(Object.keys(h.meta.docs).sort()).toEqual([
      'knowledge/architecture/a.md',
      'knowledge/architecture/b.md',
      'knowledge/ml/c.md',
    ]);

    const abs = noteAbsPathForCategory(root, 'architecture', 'a');
    const statMtime = fs.statSync(abs).mtimeMs;
    const rec = h.meta.docs['knowledge/architecture/a.md'];
    expect(rec?.mtimeMs).toBe(statMtime);
    expect(typeof rec?.id).toBe('string');
  });

  it('search-index.json / meta.json をディスクへ書く', async () => {
    const root = await mkProject();
    await addNote(root, 'architecture', 'a', {}, '## 詳細\n\n本文\n');
    await buildIndex(root);

    const paths = mnemothecaPaths(root);
    const idx = JSON.parse(fs.readFileSync(paths.searchIndexJson, 'utf8'));
    const meta = JSON.parse(fs.readFileSync(paths.metaJson, 'utf8'));
    expect(idx.v).toBe(1);
    expect(idx.tokenizerVersion).toBe(1);
    expect(idx.minisearch).toBeTypeOf('object');
    expect(meta.schemaVersion).toBe(1);
    expect(meta.fields).toEqual(['title', 'summary', 'tags', 'categories', 'content']);
  });

  it('壊れたノートはスキップし parse-errors.json に記録、docCount から除外', async () => {
    const root = await mkProject();
    await addNote(root, 'architecture', 'ok', {}, '## 詳細\n\n本文\n');
    const brokenAbs = noteAbsPathForCategory(root, 'architecture', 'broken');
    await fs.promises.mkdir(path.dirname(brokenAbs), { recursive: true });
    await fs.promises.writeFile(brokenAbs, 'no frontmatter here\n', 'utf8');

    const h = await buildIndex(root);
    expect(h.meta.docCount).toBe(1);

    const paths = mnemothecaPaths(root);
    const errs = JSON.parse(fs.readFileSync(paths.parseErrorsJson, 'utf8'));
    expect(Array.isArray(errs)).toBe(true);
    expect(errs.some((e: { path: string }) => e.path === 'knowledge/architecture/broken.md')).toBe(
      true,
    );
  });

  it('走査全体が失敗したら INDEX_BUILD_FAILED', async () => {
    const root = await mkProject();
    vi.spyOn(fs.promises, 'readdir').mockRejectedValue(
      Object.assign(new Error('EACCES'), { code: 'EACCES' }),
    );
    await expect(buildIndex(root)).rejects.toSatisfy(
      (e) => isMnemoError(e) && e.code === 'INDEX_BUILD_FAILED',
    );
  });
});

// ---------------------------------------------------------------------------
// loadIndex(§13-8)
// ---------------------------------------------------------------------------

describe('loadIndex() (§6-3 / §6-4 / §13-8)', () => {
  it('キャッシュから復元して同じ検索結果を返す', async () => {
    const root = await mkProject();
    await addNote(root, 'architecture', 'a', { title: '機械学習ノート' }, '## 詳細\n\n応用事例\n');
    const built = await buildIndex(root);
    const fromBuild = search(built, '機械学習').map((r) => r.id);

    const loaded = await loadIndex(root);
    const fromLoad = search(loaded, '機械学習').map((r) => r.id);

    expect(fromLoad).toEqual(fromBuild);
    expect(fromLoad.length).toBe(1);
  });

  it('toJSON → stringify → parse → loadJSON の往復で検索結果が一致する', async () => {
    const root = await mkProject();
    await addNote(root, 'architecture', 'a', { title: '機械学習' }, '## 詳細\n\nモデル評価\n');
    await addNote(root, 'ml', 'b', { categories: ['ml'], title: '統計' }, '## 詳細\n\n回帰分析\n');
    const built = await buildIndex(root);

    const roundtrip = MiniSearch.loadJSON(
      JSON.stringify(JSON.parse(JSON.stringify(built.ms.toJSON()))),
      buildMiniSearchOptions(),
    );
    const handle = { ms: roundtrip, meta: built.meta, projectRoot: root };

    for (const q of ['機械学習', 'モデル', '回帰', '統計']) {
      expect(search(handle, q).map((r) => r.id)).toEqual(search(built, q).map((r) => r.id));
    }
  });

  it('version 不一致(meta.schemaVersion)なら再ビルドにフォールバック', async () => {
    const root = await mkProject();
    await addNote(root, 'architecture', 'a', {}, '## 詳細\n\n本文\n');
    await buildIndex(root);

    const paths = mnemothecaPaths(root);
    const meta = JSON.parse(fs.readFileSync(paths.metaJson, 'utf8'));
    meta.schemaVersion = 999;
    fs.writeFileSync(paths.metaJson, JSON.stringify(meta));

    const loaded = await loadIndex(root);
    // 再ビルドされ meta が現行版に戻っている
    expect(loaded.meta.schemaVersion).toBe(1);
    const onDisk = JSON.parse(fs.readFileSync(paths.metaJson, 'utf8'));
    expect(onDisk.schemaVersion).toBe(1);
  });

  it('JSON 破損なら再ビルドにフォールバック', async () => {
    const root = await mkProject();
    await addNote(root, 'architecture', 'a', {}, '## 詳細\n\n本文\n');
    await buildIndex(root);

    const paths = mnemothecaPaths(root);
    fs.writeFileSync(paths.searchIndexJson, '{ this is not json');

    const loaded = await loadIndex(root);
    expect(loaded.meta.docCount).toBe(1);
    expect(search(loaded, '本文').length).toBe(1);
  });

  it('キャッシュが無ければ buildIndex する', async () => {
    const root = await mkProject();
    await addNote(root, 'architecture', 'a', {}, '## 詳細\n\n本文\n');
    const loaded = await loadIndex(root);
    expect(loaded.meta.docCount).toBe(1);
    expect(fs.existsSync(mnemothecaPaths(root).searchIndexJson)).toBe(true);
  });

  it('回帰: loadJSON に searchOptions.processTerm を渡し忘れると助詞 AND 検索が壊れる', async () => {
    const root = await mkProject();
    await addNote(root, 'ml', 'a', { categories: ['ml'], title: 'A' }, '## 詳細\n\n機械学習の応用事例\n');
    await addNote(root, 'ml', 'b', { categories: ['ml'], title: 'B' }, '## 詳細\n\n機械設計の基礎\n');
    const built = await buildIndex(root);
    const json = JSON.stringify(built.ms.toJSON());

    // 正しい options(§6-3): processTermSearch が searchOptions に入っている
    const good = MiniSearch.loadJSON(json, buildMiniSearchOptions());
    const goodHits = good.search('機械学習 の 応用', { combineWith: 'AND' });
    expect(goodHits.length).toBe(1);

    // 渡し忘れ: searchOptions.processTerm が無い → search 時 processTermIndex に
    // field なしでフォールバックし「の」が必須語に残る → 0 件(または誤絞り込み)
    const opts = buildMiniSearchOptions();
    const broken = MiniSearch.loadJSON(json, {
      ...opts,
      searchOptions: { combineWith: 'AND', tokenize: opts.searchOptions!.tokenize },
    });
    const brokenHits = broken.search('機械学習 の 応用', { combineWith: 'AND' });
    expect(brokenHits.length).not.toBe(1);
  });
});

// ---------------------------------------------------------------------------
// syncIndex(§13-8)
// ---------------------------------------------------------------------------

describe('syncIndex() (§6-3 / §13-8)', () => {
  it('変更なしなら all-zero', async () => {
    const root = await mkProject();
    await addNote(root, 'architecture', 'a', {}, '## 詳細\n\n本文\n');
    const h = await loadIndex(root);
    expect(await syncIndex(h)).toEqual({ added: 0, updated: 0, removed: 0 });
  });

  it('ファイル追加 → added:1', async () => {
    const root = await mkProject();
    await addNote(root, 'architecture', 'a', {}, '## 詳細\n\n本文\n');
    const h = await loadIndex(root);

    await addNote(root, 'architecture', 'b', {}, '## 詳細\n\n新規ノート\n');
    expect(await syncIndex(h)).toEqual({ added: 1, updated: 0, removed: 0 });
    expect(h.meta.docCount).toBe(2);
    expect(search(h, '新規ノート').length).toBe(1);
  });

  it('mtime 変化のある編集 → updated:1', async () => {
    const root = await mkProject();
    const rel = await addNote(root, 'architecture', 'a', {}, '## 詳細\n\n初版\n');
    const h = await loadIndex(root);

    const abs = noteAbsPathForCategory(root, 'architecture', 'a');
    await writeNote(abs, fm({ categories: ['architecture'], id: h.meta.docs[rel]!.id }), '## 詳細\n\n改訂版テキスト\n');
    bumpMtime(abs);

    expect(await syncIndex(h)).toEqual({ added: 0, updated: 1, removed: 0 });
    expect(search(h, '改訂版テキスト').length).toBe(1);
    expect(search(h, '初版').length).toBe(0);
  });

  it('ファイル削除 → removed:1', async () => {
    const root = await mkProject();
    await addNote(root, 'architecture', 'a', {}, '## 詳細\n\n残す\n');
    await addNote(root, 'architecture', 'b', {}, '## 詳細\n\n消す\n');
    const h = await loadIndex(root);

    fs.rmSync(noteAbsPathForCategory(root, 'architecture', 'b'));
    expect(await syncIndex(h)).toEqual({ added: 0, updated: 0, removed: 1 });
    expect(h.meta.docCount).toBe(1);
    expect(search(h, '消す').length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// applyDelta(§6-3 / §6-5)
// ---------------------------------------------------------------------------

describe('applyDelta() (§6-3)', () => {
  it('add / change / unlink をインメモリ + ディスクへ反映', async () => {
    const root = await mkProject();
    await addNote(root, 'architecture', 'a', {}, '## 詳細\n\n本文\n');
    const h = await loadIndex(root);

    const relB = await addNote(root, 'architecture', 'b', {}, '## 詳細\n\nベータ\n');
    await applyDelta(h, { type: 'add', relPath: relB });
    expect(search(h, 'ベータ').length).toBe(1);
    expect(h.meta.docCount).toBe(2);

    const absB = noteAbsPathForCategory(root, 'architecture', 'b');
    await writeNote(absB, fm({ categories: ['architecture'], id: h.meta.docs[relB]!.id }), '## 詳細\n\nガンマ更新\n');
    await applyDelta(h, { type: 'change', relPath: relB });
    expect(search(h, 'ガンマ更新').length).toBe(1);
    expect(search(h, 'ベータ').length).toBe(0);

    fs.rmSync(absB);
    await applyDelta(h, { type: 'unlink', relPath: relB });
    expect(search(h, 'ガンマ更新').length).toBe(0);
    expect(h.meta.docCount).toBe(1);

    const meta = JSON.parse(fs.readFileSync(mnemothecaPaths(root).metaJson, 'utf8'));
    expect(meta.docCount).toBe(1);
  });

  it('.md 以外の relPath は無視', async () => {
    const root = await mkProject();
    await addNote(root, 'architecture', 'a', {}, '## 詳細\n\n本文\n');
    const h = await loadIndex(root);
    await expect(
      applyDelta(h, { type: 'add', relPath: 'knowledge/architecture/notes.txt' }),
    ).resolves.toBeUndefined();
    expect(h.meta.docCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// search(§13-8)
// ---------------------------------------------------------------------------

describe('search() (§5-3 / §6-3 / §13-8)', () => {
  it('boost により title マッチが content マッチより上位', async () => {
    const root = await mkProject();
    await addNote(root, 'architecture', 'title-hit', { title: 'Kubernetes 入門' }, '## 詳細\n\n無関係な本文\n');
    await addNote(root, 'architecture', 'content-hit', { title: '無関係' }, '## 詳細\n\nKubernetes の運用手順を記録\n');
    const h = await buildIndex(root);

    const results = search(h, 'kubernetes');
    expect(results.length).toBe(2);
    expect(results[0]!.path).toBe('knowledge/architecture/title-hit.md');
  });

  it('AND 条件: 両方の語を含むノートだけがヒット', async () => {
    const root = await mkProject();
    await addNote(root, 'architecture', 'both', { title: 'X' }, '## 詳細\n\ndocker と kubernetes の連携\n');
    await addNote(root, 'architecture', 'one', { title: 'Y' }, '## 詳細\n\ndocker のみの話\n');
    const h = await buildIndex(root);

    const results = search(h, 'docker kubernetes');
    expect(results.map((r) => r.path)).toEqual(['knowledge/architecture/both.md']);
  });

  it('日本語 2-gram 部分一致(「学習」で「機械学習」がヒット)', async () => {
    const root = await mkProject();
    await addNote(root, 'ml', 'a', { categories: ['ml'], title: 'A' }, '## 詳細\n\n機械学習のノート\n');
    const h = await buildIndex(root);
    expect(search(h, '学習').length).toBe(1);
  });

  it('prefix は英数字トークンのみ(「proto」で「protocol」がヒット)', async () => {
    const root = await mkProject();
    await addNote(root, 'architecture', 'a', { title: 'A' }, '## 詳細\n\nmodel context protocol\n');
    const h = await buildIndex(root);
    expect(search(h, 'proto').length).toBe(1);
  });

  it('category / tag フィルタと limit', async () => {
    const root = await mkProject();
    await addNote(root, 'ml', 'a', { categories: ['ml'], tags: ['x'], title: 'A' }, '## 詳細\n\n共通キーワード\n');
    await addNote(root, 'ops', 'b', { categories: ['ops'], tags: ['y'], title: 'B' }, '## 詳細\n\n共通キーワード\n');
    const h = await buildIndex(root);

    expect(search(h, '共通キーワード').length).toBe(2);
    expect(search(h, '共通キーワード', { category: 'ml' }).map((r) => r.path)).toEqual([
      'knowledge/ml/a.md',
    ]);
    expect(search(h, '共通キーワード', { tag: 'y' }).map((r) => r.path)).toEqual([
      'knowledge/ops/b.md',
    ]);
    expect(search(h, '共通キーワード', { limit: 1 }).length).toBe(1);
  });

  it('結果に格納フィールド(categories / tags を配列で)を含む', async () => {
    const root = await mkProject();
    await addNote(
      root,
      'ml',
      'a',
      { categories: ['ml'], tags: ['aws', 'mcp'], title: 'タイトルX', summary: '要約Y' },
      '## 詳細\n\nキーワードZ\n',
    );
    const h = await buildIndex(root);
    const r = search(h, 'キーワードZ')[0]!;
    expect(r.categories).toEqual(['ml']);
    expect(r.tags).toEqual(['aws', 'mcp']);
    expect(r.title).toBe('タイトルX');
    expect(r.summary).toBe('要約Y');
    expect(r.path).toBe('knowledge/ml/a.md');
  });
});

// ---------------------------------------------------------------------------
// 助詞クエリ AND 検索(差し戻し 1・必須) / QUERY_TOO_SHORT 判定材料(§13-8)
// ---------------------------------------------------------------------------

describe('助詞クエリ AND 検索(§13-8・必須の統合テスト)', () => {
  async function twoNotes(): Promise<ReturnType<typeof buildIndex>> {
    const root = await mkProject();
    await addNote(root, 'ml', 'a', { categories: ['ml'], title: 'ノートA' }, '## 詳細\n\n機械学習の応用事例\n');
    await addNote(root, 'ml', 'b', { categories: ['ml'], title: 'ノートB' }, '## 詳細\n\n機械設計の基礎\n');
    return buildIndex(root);
  }

  it('「機械学習 の 応用」→ 該当ノート(A)のみヒット(「の」が必須語に残らない)', async () => {
    const h = await twoNotes();
    const results = search(h, '機械学習 の 応用');
    expect(results.map((r) => r.path)).toEqual(['knowledge/ml/a.md']);
  });

  it('「の」単体 → processTermSearch で全 term 消滅 → QUERY_TOO_SHORT 判定 & search は空配列', async () => {
    const h = await twoNotes();
    expect(searchableQueryTerms('の')).toEqual([]);
    expect(isQueryTooShort('の')).toBe(true);
    expect(search(h, 'の')).toEqual([]);
  });

  it('「the model context protocol」→ 「the」が落ち model/context/protocol で AND', async () => {
    const root = await mkProject();
    await addNote(root, 'architecture', 'a', { title: 'A' }, '## 詳細\n\nthe model context protocol とは\n');
    await addNote(root, 'architecture', 'b', { title: 'B' }, '## 詳細\n\nmodel のみ言及\n');
    const h = await buildIndex(root);

    expect(searchableQueryTerms('the model context protocol')).toEqual([
      'model',
      'context',
      'protocol',
    ]);
    expect(search(h, 'the model context protocol').map((r) => r.path)).toEqual([
      'knowledge/architecture/a.md',
    ]);
  });
});

describe('境界(§13-8)', () => {
  it('1 文字で tokenize が空になるクエリ → QUERY_TOO_SHORT 判定', () => {
    expect(isQueryTooShort('!')).toBe(true);
    expect(isQueryTooShort(' ')).toBe(true);
    expect(isQueryTooShort('')).toBe(true);
  });

  it('助詞のみのクエリ(「の は を」)→ QUERY_TOO_SHORT 判定', () => {
    expect(searchableQueryTerms('の は を')).toEqual([]);
    expect(isQueryTooShort('の は を')).toBe(true);
  });

  it('名詞的 1 文字(漢字)は検索を試行できる(QUERY_TOO_SHORT ではない)', () => {
    expect(isQueryTooShort('機')).toBe(false);
    expect(isQueryTooShort('c')).toBe(false);
  });
});
