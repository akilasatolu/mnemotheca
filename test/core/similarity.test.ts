import { describe, expect, it } from 'vitest';
import { ORGANIZE_THRESHOLDS } from '../../src/core/organize-config.js';
import {
  bigramJaccard,
  bodyHash,
  jaccard,
  tagJaccard,
  titleKey,
  toBigramSet,
} from '../../src/core/similarity.js';

describe('titleKey (§8-K / §13-9)', () => {
  it('空白・記号・約物・全半角の違いを吸収して同一キーになる', () => {
    const key = 'awsmcp実現可能性';
    expect(titleKey('AWS  MCP: 実現可能性!')).toBe(key);
    expect(titleKey('aws-mcp（実現可能性）')).toBe(key);
    expect(titleKey('ＡＷＳ　ＭＣＰ　実現可能性')).toBe(key);
  });

  it('文字・数字以外は全て除去され、文字/数字は残る', () => {
    expect(titleKey('Node.js 20 対応 / 移行メモ')).toBe('nodejs20対応移行メモ');
  });

  it('記号のみのタイトルは空文字になる', () => {
    expect(titleKey('---!!!???')).toBe('');
  });

  it('異なるタイトルは異なるキー', () => {
    expect(titleKey('機械学習の評価')).not.toBe(titleKey('データベースの設計'));
  });
});

describe('bodyHash (§8-K / §13-9)', () => {
  it('空白・改行・インデントの違いしかない 2 本文は同一ハッシュ', () => {
    const a = 'foo bar\n\n    baz qux';
    const b = '  foo   bar\tbaz\nqux  ';
    expect(bodyHash(a)).toBe(bodyHash(b));
  });

  it('全角スペースの違いも吸収する(NFKC + 連続空白圧縮)', () => {
    expect(bodyHash('機械学習　の　応用')).toBe(bodyHash('機械学習 の 応用'));
  });

  it('内容が異なれば異なるハッシュ', () => {
    expect(bodyHash('本文A です')).not.toBe(bodyHash('本文B です'));
  });

  it('sha256 hex(64 文字)を返す', () => {
    expect(bodyHash('anything')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('toBigramSet (§8-K)', () => {
  it('tokenize を利用し bigram を集合化する(重複を落とす)', () => {
    expect(toBigramSet('機械学習')).toEqual(new Set(['機械', '械学', '学習']));
  });

  it('英数字ランは 1 トークン / 記号のみは含まれない', () => {
    expect(toBigramSet('Claude Desktop !!!')).toEqual(
      new Set(['claude', 'desktop']),
    );
  });
});

describe('jaccard (§8-K / §13-9)', () => {
  it('|A ∩ B| / |A ∪ B| を返す', () => {
    expect(jaccard(new Set(['a', 'b', 'c']), new Set(['b', 'c', 'd']))).toBe(0.5);
  });

  it('同一集合 → 1、素な集合 → 0', () => {
    expect(jaccard(new Set(['x', 'y']), new Set(['x', 'y']))).toBe(1);
    expect(jaccard(new Set(['x']), new Set(['y']))).toBe(0);
  });

  it('両方空集合 → 1(J(∅,∅)=1)、片方だけ空 → 0', () => {
    expect(jaccard(new Set(), new Set())).toBe(1);
    expect(jaccard(new Set(['x']), new Set())).toBe(0);
  });
});

describe('tagJaccard (§8-K / §13-9)', () => {
  it('[a,b,c] vs [b,c,d] → 0.5', () => {
    expect(tagJaccard(['a', 'b', 'c'], ['b', 'c', 'd'])).toBe(0.5);
  });

  it('同一タグ集合 → 1 / 素 → 0 / 空同士 → 1', () => {
    expect(tagJaccard(['mcp', 'aws'], ['aws', 'mcp'])).toBe(1);
    expect(tagJaccard(['mcp'], ['llm'])).toBe(0);
    expect(tagJaccard([], [])).toBe(1);
  });

  it('trim + 空文字除去してから比較する', () => {
    expect(tagJaccard([' mcp ', 'aws', ''], ['mcp', 'aws'])).toBe(1);
  });
});

describe('bigramJaccard (§8-K / §13-9)', () => {
  it('同一本文 → 1.0', () => {
    const body = '機械学習のモデル評価と交差検証の手法について';
    expect(bigramJaccard(body, body)).toBe(1);
  });

  it('無関係な本文 → 低い(統合しきい値未満)', () => {
    const score = bigramJaccard(
      '今日は良い天気なので散歩に出かけた',
      'データベースのインデックス設計を見直す',
    );
    expect(score).toBeLessThan(ORGANIZE_THRESHOLDS.mergeCandidateBigramJaccard);
    expect(score).toBeLessThan(0.1);
  });

  it('0.60 前後の閾値挙動: 近い本文は統合候補 / やや離れると非候補', () => {
    const base = 'alpha beta gamma delta epsilon';
    const near = 'alpha beta gamma delta zeta'; // 共通4 / 和6 = 0.667
    const far = 'alpha beta gamma phi zeta'; //     共通3 / 和7 ≈ 0.429

    const nearScore = bigramJaccard(base, near);
    const farScore = bigramJaccard(base, far);

    expect(nearScore).toBeCloseTo(4 / 6, 10);
    expect(farScore).toBeCloseTo(3 / 7, 10);

    // 定数経由で閾値挙動を検証(マジックナンバーを埋め込まない)
    expect(nearScore).toBeGreaterThanOrEqual(
      ORGANIZE_THRESHOLDS.mergeCandidateBigramJaccard,
    );
    expect(farScore).toBeLessThan(
      ORGANIZE_THRESHOLDS.mergeCandidateBigramJaccard,
    );
  });
});
