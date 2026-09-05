import { describe, expect, it } from 'vitest';

import { ORGANIZE_THRESHOLDS } from '../../../src/core/organize-config.js';
import {
  detectAll,
  detectDuplicates,
  detectFixFrontmatter,
  detectMergeCategory,
  detectMoveUncategorized,
  detectSplitCategory,
  detectSplitFile,
  detectStale,
  type DetectNote,
} from '../../../src/mcp/organize/detect.js';

const T = ORGANIZE_THRESHOLDS;

function note(overrides: Partial<DetectNote> & { relPath: string }): DetectNote {
  return {
    category: 'misc',
    title: overrides.relPath,
    body: 'default body text',
    tags: [],
    updated: '2026-09-01T00:00:00+09:00',
    created: '',
    categoriesScalar: false,
    ...overrides,
  };
}

describe('detectSplitCategory (§8-N / §13-11)', () => {
  it('同一カテゴリが subdivideMinFiles 件以上 + タグ偏り(share < clusterTagMinShare)→ 分割提案', () => {
    const size = 25;
    const clustered = T.subdivideMinFiles; // 偏っているタグの件数 = 閾値ちょうど
    const notes: DetectNote[] = [];
    for (let i = 0; i < size; i += 1) {
      notes.push(
        note({
          relPath: `knowledge/react/n${i}.md`,
          category: 'react',
          tags: i < clustered ? ['hooks'] : [],
        }),
      );
    }
    const out = detectSplitCategory(notes, T);
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe('split-category');
    expect(out[0]?.evidence).toMatchObject({
      category: 'react',
      clusterTag: 'hooks',
      clusterCount: clustered,
      thresholdKey: 'subdivideMinFiles',
    });
    expect((out[0]?.evidence.clusterShare as number)).toBeLessThan(T.clusterTagMinShare);
  });

  it('クラスタタグ件数が閾値未満なら提案しない(境界)', () => {
    const size = 25;
    const notes: DetectNote[] = [];
    for (let i = 0; i < size; i += 1) {
      notes.push(
        note({
          relPath: `knowledge/react/n${i}.md`,
          category: 'react',
          tags: i < T.subdivideMinFiles - 1 ? ['hooks'] : [],
        }),
      );
    }
    expect(detectSplitCategory(notes, T)).toHaveLength(0);
  });

  it('カテゴリ件数が subdivideMinFiles 未満なら提案しない', () => {
    const notes = Array.from({ length: T.subdivideMinFiles - 1 }, (_, i) =>
      note({ relPath: `knowledge/react/n${i}.md`, category: 'react', tags: ['hooks'] }),
    );
    expect(detectSplitCategory(notes, T)).toHaveLength(0);
  });

  it('全ノートが同じタグ(share >= clusterTagMinShare)なら分割しない', () => {
    const notes = Array.from({ length: 20 }, (_, i) =>
      note({ relPath: `knowledge/react/n${i}.md`, category: 'react', tags: ['hooks'] }),
    );
    expect(detectSplitCategory(notes, T)).toHaveLength(0);
  });
});

describe('detectMergeCategory (§8-N / §13-11)', () => {
  it('2 カテゴリの集約本文 bigram Jaccard >= mergeCandidateBigramJaccard → 統合提案', () => {
    const shared = 'React のフックについて useState と useEffect を使ってコンポーネントを実装する';
    const notes = [
      note({ relPath: 'knowledge/react/a.md', category: 'react', body: shared }),
      note({ relPath: 'knowledge/reactjs/b.md', category: 'reactjs', body: shared }),
    ];
    const out = detectMergeCategory(notes, T);
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe('merge-category');
    expect(out[0]?.requiresIndividualApproval).toBe(true);
    expect(out[0]?.evidence.categories).toEqual(['react', 'reactjs']);
    expect((out[0]?.evidence.bigramJaccard as number)).toBeGreaterThanOrEqual(
      T.mergeCandidateBigramJaccard,
    );
  });

  it('無関係な 2 カテゴリは統合提案しない', () => {
    const notes = [
      note({ relPath: 'knowledge/react/a.md', category: 'react', body: 'React フック useState useEffect' }),
      note({ relPath: 'knowledge/cooking/b.md', category: 'cooking', body: '玉ねぎ を炒めてカレー を作る' }),
    ];
    expect(detectMergeCategory(notes, T)).toHaveLength(0);
  });
});

describe('detectDuplicates (§8-N / §13-11)', () => {
  it('titleKey 完全一致 2 件 → duplicate 提案(reason: title-exact)', () => {
    const notes = [
      note({ relPath: 'knowledge/a/x.md', title: 'AWS  MCP: 実現可能性!' }),
      note({ relPath: 'knowledge/b/y.md', title: 'aws-mcp（実現可能性）' }),
    ];
    const out = detectDuplicates(notes, T).filter((s) => s.evidence.reason === 'title-exact');
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe('duplicate');
    expect(out[0]?.targets).toEqual(['knowledge/a/x.md', 'knowledge/b/y.md']);
    expect(out[0]?.requiresIndividualApproval).toBe(true);
  });

  it('本文 sha256(bodyHash)一致 2 件 → duplicate 提案(reason: body-hash)', () => {
    const notes = [
      note({ relPath: 'knowledge/a/x.md', title: '別タイトル A', body: '同じ 本文  です\n\n' }),
      note({ relPath: 'knowledge/b/y.md', title: '別タイトル B', body: '同じ   本文 です' }),
    ];
    const out = detectDuplicates(notes, T).filter((s) => s.evidence.reason === 'body-hash');
    expect(out).toHaveLength(1);
    expect(out[0]?.evidence.count).toBe(2);
  });

  it('一致しなければ提案なし', () => {
    const notes = [
      note({ relPath: 'knowledge/a/x.md', title: 'A', body: 'aaa' }),
      note({ relPath: 'knowledge/b/y.md', title: 'B', body: 'bbb' }),
    ];
    expect(detectDuplicates(notes, T)).toHaveLength(0);
  });
});

describe('detectMoveUncategorized (§8-N / §13-11)', () => {
  it('_uncategorized のノートが既存カテゴリと Jaccard >= uncategorizedAssignMinJaccard → 割り当て提案', () => {
    const body = '機械学習 モデル の 評価 指標 と 精度 の 話';
    const notes = [
      note({ relPath: 'knowledge/ml/a.md', category: 'ml', body }),
      note({ relPath: 'knowledge/ml/b.md', category: 'ml', body }),
      note({ relPath: 'knowledge/_uncategorized/c.md', category: '_uncategorized', body }),
    ];
    const out = detectMoveUncategorized(notes, T);
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe('move-uncategorized');
    expect(out[0]?.targets).toEqual(['knowledge/_uncategorized/c.md']);
    expect(out[0]?.evidence).toMatchObject({
      candidateCategory: 'ml',
      thresholdKey: 'uncategorizedAssignMinJaccard',
    });
    expect((out[0]?.evidence.jaccard as number)).toBeGreaterThanOrEqual(
      T.uncategorizedAssignMinJaccard,
    );
  });

  it('既存カテゴリと無関係な _uncategorized ノートは提案しない', () => {
    const notes = [
      note({ relPath: 'knowledge/ml/a.md', category: 'ml', body: '機械学習 モデル 評価 精度' }),
      note({ relPath: 'knowledge/_uncategorized/c.md', category: '_uncategorized', body: '旅行 の 予約 と 宿泊 費' }),
    ];
    expect(detectMoveUncategorized(notes, T)).toHaveLength(0);
  });

  it('_uncategorized が無ければ提案なし', () => {
    const notes = [note({ relPath: 'knowledge/ml/a.md', category: 'ml' })];
    expect(detectMoveUncategorized(notes, T)).toHaveLength(0);
  });
});

describe('detectStale (§8-N / §13-11)', () => {
  const now = Date.parse('2026-09-03T00:00:00+09:00');

  it('updated が staleDays 超 かつ reference/permanent タグ無し → stale フラグ', () => {
    const notes = [note({ relPath: 'knowledge/a/old.md', updated: '2024-01-01T00:00:00+09:00' })];
    const out = detectStale(notes, T, now);
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe('stale-content');
    expect(out[0]?.destructiveness).toBe('safe');
    expect(out[0]?.evidence.thresholdKey).toBe('staleDays');
    expect((out[0]?.evidence.ageDays as number)).toBeGreaterThan(T.staleDays);
  });

  it('reference / permanent タグ付きは stale にしない', () => {
    const notes = [
      note({ relPath: 'knowledge/a/r.md', updated: '2020-01-01T00:00:00+09:00', tags: ['reference'] }),
      note({ relPath: 'knowledge/a/p.md', updated: '2020-01-01T00:00:00+09:00', tags: ['permanent'] }),
    ];
    expect(detectStale(notes, T, now)).toHaveLength(0);
  });

  it('staleDays 以内の更新は stale にしない', () => {
    const notes = [note({ relPath: 'knowledge/a/fresh.md', updated: '2026-08-01T00:00:00+09:00' })];
    expect(detectStale(notes, T, now)).toHaveLength(0);
  });

  it('updated がパース不能なら無視して例外を投げない', () => {
    const notes = [note({ relPath: 'knowledge/a/x.md', updated: 'not-a-date' })];
    expect(detectStale(notes, T, now)).toHaveLength(0);
  });
});

describe('detectSplitFile (§8-N / §13-11)', () => {
  it('日付プレフィックス命名(YYYY-MM-DD-)→ split-file 提案', () => {
    const out = detectSplitFile([
      note({ relPath: 'knowledge/journal/2026-09-01-daily-log.md' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe('split-file');
    expect(out[0]?.destructiveness).toBe('safe');
    expect(out[0]?.targets).toEqual(['knowledge/journal/2026-09-01-daily-log.md']);
    expect(out[0]?.evidence).toMatchObject({ reason: 'date-prefix', filename: '2026-09-01-daily-log.md' });
  });

  it('日付プレフィックスでない通常 slug は提案しない', () => {
    expect(detectSplitFile([note({ relPath: 'knowledge/journal/daily-log.md' })])).toHaveLength(0);
  });

  it('日付が途中に含まれるだけ(先頭でない)は提案しない', () => {
    expect(
      detectSplitFile([note({ relPath: 'knowledge/journal/log-2026-09-01.md' })]),
    ).toHaveLength(0);
  });
});

describe('detectFixFrontmatter (§8-N / §13-11)', () => {
  it('categories がスカラー → fix-frontmatter(reason: categories-scalar)', () => {
    const out = detectFixFrontmatter([
      note({ relPath: 'knowledge/tech/a.md', category: 'tech', categoriesScalar: true }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe('fix-frontmatter');
    expect(out[0]?.evidence.reasons).toContain('categories-scalar');
  });

  it('categories[0] が実ディレクトリ経路と不一致 → category-path-mismatch', () => {
    const out = detectFixFrontmatter([
      note({ relPath: 'knowledge/tech/a.md', category: 'misc' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.evidence).toMatchObject({ declaredCategory: 'misc', dirCategory: 'tech' });
    expect(out[0]?.evidence.reasons).toContain('category-path-mismatch');
  });

  it('created > updated → created-after-updated', () => {
    const out = detectFixFrontmatter([
      note({
        relPath: 'knowledge/tech/a.md',
        category: 'tech',
        created: '2026-09-10T00:00:00+09:00',
        updated: '2026-09-01T00:00:00+09:00',
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.evidence.reasons).toContain('created-after-updated');
  });

  it('不整合なし(経路一致・配列 categories・created <= updated)→ 提案しない', () => {
    expect(
      detectFixFrontmatter([
        note({
          relPath: 'knowledge/tech/a.md',
          category: 'tech',
          created: '2026-09-01T00:00:00+09:00',
          updated: '2026-09-02T00:00:00+09:00',
        }),
      ]),
    ).toHaveLength(0);
  });

  it('knowledge 直下(カテゴリ経路なし)は mismatch を出さない', () => {
    expect(
      detectFixFrontmatter([note({ relPath: 'knowledge/a.md', category: '_uncategorized' })]),
    ).toHaveLength(0);
  });
});

describe('detectAll', () => {
  it('空配列 → 提案 0・例外なし', () => {
    expect(detectAll([], T, Date.now())).toEqual([]);
  });

  it('split-file / fix-frontmatter も detectAll 経由で拾う', () => {
    const out = detectAll(
      [
        note({ relPath: 'knowledge/journal/2026-09-01-x.md', category: 'journal' }),
        note({ relPath: 'knowledge/tech/y.md', category: 'wrong' }),
      ],
      T,
      Date.parse('2026-09-03T00:00:00+09:00'),
    );
    expect(out.some((s) => s.kind === 'split-file')).toBe(true);
    expect(out.some((s) => s.kind === 'fix-frontmatter')).toBe(true);
  });
});
