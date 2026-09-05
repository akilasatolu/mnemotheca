import { describe, expect, it } from 'vitest';
import {
  processTermIndex,
  processTermSearch,
  TOKENIZER_VERSION,
  tokenize,
} from '../../src/core/tokenizer.js';

describe('tokenize (§5-1 / §13-1)', () => {
  it('CJK は bigram 化する(「機械学習」→ 機械 / 械学 / 学習)', () => {
    expect(tokenize('機械学習')).toEqual(['機械', '械学', '学習']);
  });

  it('英数字ランは 1 トークン(bigram 化しない)', () => {
    expect(tokenize('Claude Desktop')).toEqual(['claude', 'desktop']);
    expect(tokenize('MCP2')).toEqual(['mcp2']);
    expect(tokenize('gpt-4o の 評価')).toEqual(['gpt-4o', 'の', '評価']);
  });

  it('tokenize は助詞を落とさない(「の」は 1 文字ランとして残る)', () => {
    expect(tokenize('機械学習 の 応用')).toEqual([
      '機械',
      '械学',
      '学習',
      'の',
      '応用',
    ]);
  });

  it('1 文字はそのまま採用する(英字・かな)', () => {
    expect(tokenize('A')).toEqual(['a']);
    expect(tokenize('あ')).toEqual(['あ']);
  });

  it('空文字・記号のみは落とす(最小 2 文字 / ノイズ除去)', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('   ')).toEqual([]);
    expect(tokenize('!!!???')).toEqual([]);
    expect(tokenize('!!!')).toEqual([]);
  });

  it('NFKC 正規化 + 小文字化(全角英数字・半角カナ)', () => {
    expect(tokenize('ＭＣＰ２')).toEqual(['mcp2']);
    // 半角カナ「ｶﾀｶﾅ」→ NFKC → 「カタカナ」→ bigram
    expect(tokenize('ｶﾀｶﾅ')).toEqual(['カタ', 'タカ', 'カナ']);
  });

  it('区切り(空白・記号)を越えて bigram を作らない', () => {
    expect(tokenize('機械・学習')).toEqual(['機械', '学習']);
    expect(tokenize('機械学習。応用')).toEqual(['機械', '械学', '学習', '応用']);
  });

  it('field の有無で結果が変わらない(§5-1)', () => {
    expect(tokenize('の')).toEqual(tokenize('の', 'content'));
    expect(tokenize('機械学習', 'title')).toEqual(tokenize('機械学習'));
  });
});

describe('processTermIndex(term, field) (§5-2-1 / §13-1)', () => {
  it('content / summary ではストップワード(助詞)を除外する', () => {
    expect(processTermIndex('の', 'content')).toBeNull();
    expect(processTermIndex('の', 'summary')).toBeNull();
  });

  it('title / tags / categories では助詞を残す(識別情報になり得る)', () => {
    expect(processTermIndex('の', 'title')).toBe('の');
    expect(processTermIndex('の', 'tags')).toBe('の');
    expect(processTermIndex('の', 'categories')).toBe('の');
  });

  it('英語ストップワードは content で除外 / title では残す', () => {
    expect(processTermIndex('the', 'content')).toBeNull();
    expect(processTermIndex('the', 'title')).toBe('the');
    expect(processTermIndex('the', 'tags')).toBe('the');
  });

  it('名詞的トークンは content でも残る / 記号のみは常に落ちる', () => {
    expect(processTermIndex('機械', 'content')).toBe('機械');
    expect(processTermIndex('!!!', 'content')).toBeNull();
    expect(processTermIndex('!!!', 'title')).toBeNull();
  });

  it('field なし(index の保険)は記号のみチェックだけ', () => {
    expect(processTermIndex('の')).toBe('の');
    expect(processTermIndex('the')).toBe('the');
    expect(processTermIndex('!!!')).toBeNull();
  });

  it('空・空白のみは null', () => {
    expect(processTermIndex('', 'title')).toBeNull();
    expect(processTermIndex('   ', 'title')).toBeNull();
  });
});

describe('processTermSearch(term) (§5-2-2 / §13-1)', () => {
  it('field によらず助詞・英語ストップワードを常に除外する', () => {
    expect(processTermSearch('の')).toBeNull();
    expect(processTermSearch('は')).toBeNull();
    expect(processTermSearch('を')).toBeNull();
    expect(processTermSearch('the')).toBeNull();
    expect(processTermSearch('a')).toBeNull();
  });

  it('名詞・英数字トークンは残す', () => {
    expect(processTermSearch('機械')).toBe('機械');
    expect(processTermSearch('gpt-4o')).toBe('gpt-4o');
    expect(processTermSearch('mcp')).toBe('mcp');
  });

  it('記号のみは null', () => {
    expect(processTermSearch('!!!')).toBeNull();
  });
});

describe('回帰: 「機械学習 の 応用」検索クエリ(差し戻し 1・必須)', () => {
  it('tokenize → processTermSearch を通した最終 term 集合に「の」が含まれない', () => {
    const finalTerms = tokenize('機械学習 の 応用')
      .map((t) => processTermSearch(t))
      .filter((t): t is string => t !== null);

    expect(finalTerms).not.toContain('の');
    expect(finalTerms).toEqual(['機械', '械学', '学習', '応用']);
  });

  it('同じ文字列を processTermIndex(_, "content") に通しても「の」が落ちる(index/search 一致)', () => {
    const indexTerms = tokenize('機械学習の応用')
      .map((t) => processTermIndex(t, 'content'))
      .filter((t): t is string => t !== null);

    expect(indexTerms).not.toContain('の');
  });
});

describe('TOKENIZER_VERSION (§5-5)', () => {
  it('初期値は 1', () => {
    expect(TOKENIZER_VERSION).toBe(1);
  });
});
