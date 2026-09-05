import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertCategoryPathInvariant,
  isSingleSegment,
} from '../../src/core/category.js';
import { isMnemoError, type ErrorCode } from '../../src/core/errors.js';
import {
  FRONTMATTER_KEYS,
  normalizeFrontmatter,
  parseNote,
  serializeNote,
  validateFrontmatter,
  type Frontmatter,
} from '../../src/core/frontmatter.js';
import { makeProject } from '../helpers/project.js';

const roots: string[] = [];

async function mkProject(): Promise<string> {
  const root = await makeProject();
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const d = roots.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

/** MnemoError の code を取り出す(型ガード付き)。 */
function codeOf(fn: () => unknown): ErrorCode | undefined {
  try {
    fn();
  } catch (err) {
    return isMnemoError(err) ? err.code : undefined;
  }
  return undefined;
}

function fullFm(overrides: Partial<Frontmatter> = {}): Frontmatter {
  return {
    id: '20260901T093015123k7f2a',
    title: 'AWS 上での MCP ナレッジ保管フィージビリティ',
    categories: ['architecture'],
    tags: ['aws', 'mcp', 'bedrock'],
    created: '2026-09-01T09:30:15+09:00',
    updated: '2026-09-01T09:30:15+09:00',
    summary: 'AWS 上で MCP ベースのナレッジ保管を実装する場合の構成と制約を整理。',
    source: 'claude-desktop',
    ...overrides,
  };
}

const BODY = '## 要約\n\n要約本文\n\n## 詳細\n\n詳細本文\n';

// ---------------------------------------------------------------------------
// parseNote / serializeNote — round-trip
// ---------------------------------------------------------------------------

describe('parseNote / serializeNote round-trip (§13-2)', () => {
  it('全フィールドを round-trip する(parse→serialize→parse で fm 一致)', () => {
    const raw = serializeNote(fullFm(), BODY);
    const first = parseNote(raw);
    const round = serializeNote(first.fm, first.body);
    const second = parseNote(round);

    expect(first.fm).toEqual(fullFm());
    expect(second.fm).toEqual(first.fm);
    expect(second.body).toBe(first.body);
    expect(round).toBe(raw);
  });

  it('YAML キー順が §10-2 の固定順で出力される', () => {
    // わざと順不同で渡しても出力順は固定
    const shuffled = {
      summary: 's',
      title: 't',
      source: 'claude-code',
      created: '2026-09-01T00:00:00+09:00',
      id: 'abc',
      tags: ['x'],
      updated: '2026-09-01T00:00:00+09:00',
      categories: ['c'],
    } as unknown as Frontmatter;
    const out = serializeNote(shuffled, 'body\n');
    const yamlBlock = out.split('---')[1] ?? '';
    const keyOrder = yamlBlock
      .split('\n')
      .map((l) => l.match(/^([a-z]+):/)?.[1])
      .filter((k): k is string => Boolean(k));
    expect(keyOrder).toEqual([...FRONTMATTER_KEYS]);
  });

  it('categories / tags をフロー配列で出力する', () => {
    const out = serializeNote(fullFm({ categories: ['architecture'], tags: ['aws', 'mcp'] }), BODY);
    expect(out).toContain('categories: [architecture]');
    expect(out).toContain('tags: [aws, mcp]');
  });

  it('source 省略時は YAML に source 行を出さない', () => {
    const { source: _omit, ...rest } = fullFm();
    const out = serializeNote(rest as Frontmatter, BODY);
    expect(out).not.toContain('source:');
    expect(parseNote(out).fm.source).toBeUndefined();
  });

  it('タイムゾーン付き日付は文字列のまま round-trip する(Date にならない)', () => {
    const raw = serializeNote(fullFm(), BODY);
    const parsed = parseNote(raw);
    expect(typeof parsed.fm.created).toBe('string');
    expect(parsed.fm.created).toBe('2026-09-01T09:30:15+09:00');
  });

  it('引用符なしの日付(js-yaml が Date 化する形)も文字列へ戻す', () => {
    const raw = ['---', 'id: x', 'created: 2026-09-01T09:30:15.000Z', 'categories: [a]', '---', 'body'].join(
      '\n',
    );
    const parsed = parseNote(raw);
    expect(typeof parsed.fm.created).toBe('string');
    expect(parsed.fm.created).toBe('2026-09-01T09:30:15.000Z');
  });
});

// ---------------------------------------------------------------------------
// parseNote — 異常系
// ---------------------------------------------------------------------------

describe('parseNote 異常系 (§13-2)', () => {
  it('frontmatter 無し → FRONTMATTER_PARSE', () => {
    expect(codeOf(() => parseNote('# ただの Markdown\n\n本文だけ'))).toBe('FRONTMATTER_PARSE');
  });

  it('空の frontmatter ブロック → FRONTMATTER_PARSE', () => {
    expect(codeOf(() => parseNote('---\n---\n本文'))).toBe('FRONTMATTER_PARSE');
  });

  it('壊れた YAML → FRONTMATTER_PARSE', () => {
    expect(codeOf(() => parseNote('---\nid: [unclosed\ntitle: x\n---\n本文'))).toBe('FRONTMATTER_PARSE');
  });
});

// ---------------------------------------------------------------------------
// validateFrontmatter
// ---------------------------------------------------------------------------

describe('validateFrontmatter (§13-2)', () => {
  it('正常な frontmatter は通過する', () => {
    expect(() => validateFrontmatter(fullFm())).not.toThrow();
  });

  it('categories 空配列 → FRONTMATTER_SCHEMA', () => {
    expect(codeOf(() => validateFrontmatter(fullFm({ categories: [] })))).toBe('FRONTMATTER_SCHEMA');
  });

  it('title 200 字は許容、201 字は FRONTMATTER_SCHEMA(境界)', () => {
    expect(() => validateFrontmatter(fullFm({ title: 'あ'.repeat(200) }))).not.toThrow();
    expect(codeOf(() => validateFrontmatter(fullFm({ title: 'あ'.repeat(201) })))).toBe(
      'FRONTMATTER_SCHEMA',
    );
  });

  it('title 空文字 → FRONTMATTER_SCHEMA', () => {
    expect(codeOf(() => validateFrontmatter(fullFm({ title: '' })))).toBe('FRONTMATTER_SCHEMA');
  });

  it('summary 空文字は許容(境界)', () => {
    expect(() => validateFrontmatter(fullFm({ summary: '' }))).not.toThrow();
  });

  it('created がパース不能 → FRONTMATTER_SCHEMA', () => {
    expect(codeOf(() => validateFrontmatter(fullFm({ created: 'not-a-date' })))).toBe(
      'FRONTMATTER_SCHEMA',
    );
  });

  it('id 非空必須 / tags は配列必須', () => {
    expect(codeOf(() => validateFrontmatter(fullFm({ id: '' })))).toBe('FRONTMATTER_SCHEMA');
    expect(
      codeOf(() => validateFrontmatter({ ...fullFm(), tags: 'aws' } as unknown)),
    ).toBe('FRONTMATTER_SCHEMA');
  });

  it('source が enum 外 → FRONTMATTER_SCHEMA', () => {
    expect(
      codeOf(() => validateFrontmatter({ ...fullFm(), source: 'chatgpt' } as unknown)),
    ).toBe('FRONTMATTER_SCHEMA');
  });
});

// ---------------------------------------------------------------------------
// normalizeFrontmatter
// ---------------------------------------------------------------------------

describe('normalizeFrontmatter (§13-2)', () => {
  it('スカラー category → categories:[...]', () => {
    const input = {
      id: 'x',
      title: 't',
      category: 'architecture',
      tags: [],
      created: '2026-09-01T00:00:00+09:00',
      updated: '2026-09-01T00:00:00+09:00',
      summary: '',
    } as unknown as Frontmatter;
    const out = normalizeFrontmatter(input);
    expect(out.categories).toEqual(['architecture']);
    expect((out as unknown as Record<string, unknown>)['category']).toBeUndefined();
  });

  it('created > updated なら updated を created に補正する', () => {
    const out = normalizeFrontmatter(
      fullFm({ created: '2026-09-05T00:00:00+09:00', updated: '2026-09-01T00:00:00+09:00' }),
    );
    expect(out.updated).toBe('2026-09-05T00:00:00+09:00');
  });

  it('created <= updated は変更しない', () => {
    const out = normalizeFrontmatter(
      fullFm({ created: '2026-09-01T00:00:00+09:00', updated: '2026-09-05T00:00:00+09:00' }),
    );
    expect(out.updated).toBe('2026-09-05T00:00:00+09:00');
  });

  it('tags を trim + 重複除去(小文字化はしない)', () => {
    const out = normalizeFrontmatter(fullFm({ tags: [' aws ', 'aws', 'MCP', 'mcp', 'MCP', '  '] }));
    expect(out.tags).toEqual(['aws', 'MCP', 'mcp']);
  });

  it('不採用フィールド(aliases / cssclasses)を除去する', () => {
    const input = { ...fullFm(), aliases: ['a'], cssclasses: ['b'] } as unknown as Frontmatter;
    const out = normalizeFrontmatter(input) as unknown as Record<string, unknown>;
    expect(out['aliases']).toBeUndefined();
    expect(out['cssclasses']).toBeUndefined();
  });

  it('source が enum 外なら unknown に落とす', () => {
    const input = { ...fullFm(), source: 'chatgpt' } as unknown as Frontmatter;
    expect(normalizeFrontmatter(input).source).toBe('unknown');
  });

  it('normalize→validate が通り、round-trip できる', () => {
    const normalized = normalizeFrontmatter(fullFm());
    expect(() => validateFrontmatter(normalized)).not.toThrow();
    expect(parseNote(serializeNote(normalized, BODY)).fm).toEqual(normalized);
  });
});

// ---------------------------------------------------------------------------
// category — isSingleSegment
// ---------------------------------------------------------------------------

describe('isSingleSegment', () => {
  it('単一セグメントを受理する', () => {
    expect(isSingleSegment('architecture')).toBe(true);
    expect(isSingleSegment('_uncategorized')).toBe(true);
    expect(isSingleSegment('aws-mcp')).toBe(true);
  });

  it('スラッシュ・空・.. を拒否する', () => {
    expect(isSingleSegment('tech/architecture')).toBe(false);
    expect(isSingleSegment('')).toBe(false);
    expect(isSingleSegment('..')).toBe(false);
    expect(isSingleSegment('.')).toBe(false);
    expect(isSingleSegment('a\\b')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// category — assertCategoryPathInvariant
// ---------------------------------------------------------------------------

describe('assertCategoryPathInvariant (§10-2-3 / §13-2)', () => {
  async function noteAt(relDir: string): Promise<{ absPath: string; projectRoot: string }> {
    const projectRoot = await mkProject();
    const dir = path.join(projectRoot, 'vault', 'knowledge', relDir);
    fs.mkdirSync(dir, { recursive: true });
    return { absPath: path.join(dir, 'note.md'), projectRoot };
  }

  it('categories[0] === 実ディレクトリ(単一セグメント)なら通過する', async () => {
    const { absPath, projectRoot } = await noteAt('architecture');
    expect(() =>
      assertCategoryPathInvariant(fullFm({ categories: ['architecture'] }), absPath, projectRoot, {
        requireSingleSegment: true,
      }),
    ).not.toThrow();
  });

  it('organize 後の多階層 categories[0](実ディレクトリ一致)は通過する', async () => {
    const { absPath, projectRoot } = await noteAt(path.join('tech', 'architecture'));
    expect(() =>
      assertCategoryPathInvariant(
        fullFm({ categories: ['tech/architecture', 'aws'] }),
        absPath,
        projectRoot,
      ),
    ).not.toThrow();
  });

  it('categories[0] にスラッシュ(store 経路)→ CATEGORY_INVARIANT', async () => {
    const { absPath, projectRoot } = await noteAt(path.join('tech', 'architecture'));
    const code = codeOf(() =>
      assertCategoryPathInvariant(
        fullFm({ categories: ['tech/architecture'] }),
        absPath,
        projectRoot,
        { requireSingleSegment: true },
      ),
    );
    expect(code).toBe('CATEGORY_INVARIANT');
  });

  it('categories[0] != 実ディレクトリ → CATEGORY_INVARIANT(expected/actual を details に含む)', async () => {
    const { absPath, projectRoot } = await noteAt('architecture');
    let caught: unknown;
    try {
      assertCategoryPathInvariant(fullFm({ categories: ['aws'] }), absPath, projectRoot);
    } catch (err) {
      caught = err;
    }
    expect(isMnemoError(caught)).toBe(true);
    if (isMnemoError(caught)) {
      expect(caught.code).toBe('CATEGORY_INVARIANT');
      expect(caught.details).toMatchObject({ expected: 'architecture', actual: 'aws' });
    }
  });

  it('categories[0] に .. → CATEGORY_INVARIANT', async () => {
    const { absPath, projectRoot } = await noteAt('architecture');
    expect(
      codeOf(() =>
        assertCategoryPathInvariant(fullFm({ categories: ['../escape'] }), absPath, projectRoot),
      ),
    ).toBe('CATEGORY_INVARIANT');
  });

  it('categories[0] が先頭 / → CATEGORY_INVARIANT', async () => {
    const { absPath, projectRoot } = await noteAt('architecture');
    expect(
      codeOf(() =>
        assertCategoryPathInvariant(fullFm({ categories: ['/architecture'] }), absPath, projectRoot),
      ),
    ).toBe('CATEGORY_INVARIANT');
  });

  it('categories[0] が空文字 → CATEGORY_INVARIANT', async () => {
    const { absPath, projectRoot } = await noteAt('architecture');
    expect(
      codeOf(() =>
        assertCategoryPathInvariant(fullFm({ categories: [''] }), absPath, projectRoot),
      ),
    ).toBe('CATEGORY_INVARIANT');
  });
});
