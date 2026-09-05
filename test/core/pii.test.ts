import { describe, expect, it } from 'vitest';
import {
  BLOCK_PATTERNS,
  isPlaceholder,
  PII_PATTERNS,
  scanPii,
  WARN_PATTERNS,
} from '../../src/core/pii.js';

// テストデータに本物のクレデンシャルは書かない。
// AWS 公式 example 値・明らかなダミー文字列のみを使う。

describe('正規表現の健全性 (§13-7)', () => {
  it('全パターンが new RegExp(source, flags) で例外なく構築できる（インラインフラグ混入検出）', () => {
    for (const p of PII_PATTERNS) {
      expect(() => new RegExp(p.re.source, p.re.flags)).not.toThrow();
      expect(p.re.source).not.toMatch(/\(\?[imsu]+[):]/); // (?i) (?m) (?s) (?i:) など
    }
  });

  it('全 re.flags に g を含む', () => {
    for (const p of PII_PATTERNS) {
      expect(p.re.flags).toContain('g');
    }
  });

  it('BLOCK 13 種 / WARN 7 種', () => {
    expect(BLOCK_PATTERNS).toHaveLength(13);
    expect(WARN_PATTERNS).toHaveLength(7);
    expect(BLOCK_PATTERNS.every((p) => p.severity === 'block')).toBe(true);
    expect(WARN_PATTERNS.every((p) => p.severity === 'warn')).toBe(true);
  });

  it('パターン名に重複がない', () => {
    const names = PII_PATTERNS.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

const blockNames = (text: string): string[] => scanPii(text).blocks.map((h) => h.pattern);
const warnNames = (text: string): string[] => scanPii(text).warns.map((h) => h.pattern);

describe('BLOCK パターン (§13-7)', () => {
  it('AKIA + 16 英数字 → block (AWS 公式 example 値)', () => {
    expect(blockNames('key: AKIAIOSFODNN7EXAMPLE here')).toContain('aws-access-key-id');
  });

  it('sk-ant-... → block (demoteIf/requireNearby undefined のパターンはそのまま採用)', () => {
    expect(blockNames('anthropic: sk-ant-api03-DUMMYdummyDUMMYdummy0123')).toContain(
      'anthropic-key',
    );
  });

  it('GitHub token → block', () => {
    expect(
      blockNames('ghp_0123456789abcdefghijklmnopqrstuvwxyz012345'),
    ).toContain('github-token');
  });

  it('OpenAI key(非プレースホルダ)→ block', () => {
    expect(blockNames('OPENAI_API_KEY=sk-abcd1234EFGH5678ijkl9012mnop')).toContain('openai-key');
  });

  it('PEM 秘密鍵ヘッダ → block', () => {
    expect(blockNames('-----BEGIN RSA PRIVATE KEY-----\n...\n')).toContain('private-key-block');
  });

  it('JWT 3 パート → block', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    expect(blockNames(`token=${jwt}`)).toContain('jwt');
  });

  it('generic-secret-assignment: 実値 → block', () => {
    expect(blockNames('password = "s3cr3tValue123456"')).toContain('generic-secret-assignment');
  });

  it('npm token → block', () => {
    expect(
      blockNames('//registry:_authToken=npm_0123456789abcdefghijklmnopqrstuvwxyz'),
    ).toContain('npm-token');
  });

  it('日本語の氏名・住所は追わない（設計 §7 スコープ外）', () => {
    const r = scanPii('山田花子さんの住所は東京都渋谷区神南一丁目です');
    expect(r.blocks).toHaveLength(0);
    expect(r.warns).toHaveLength(0);
  });
});

describe('aws-secret-access-key の requireNearby 窓 (§13-7)', () => {
  const secret40 = 'abcd1234EFGH5678ijklMNOP9012qrstUVWX3456'; // 40 文字ダミー base64 様

  it('40 文字 base64 単独（近傍にキーワード無し）→ 不採用', () => {
    const r = scanPii(`random blob ${secret40} end`);
    expect(r.blocks.map((h) => h.pattern)).not.toContain('aws-secret-access-key');
    expect(r.warns.map((h) => h.pattern)).not.toContain('aws-secret-access-key');
  });

  it('直前に aws_secret_access_key = があれば → block', () => {
    expect(blockNames(`aws_secret_access_key = ${secret40}`)).toContain('aws-secret-access-key');
  });

  it('近傍窓の境界(前後 200 字): 窓内なら採用 / 窓外なら不採用', () => {
    // キーワード "aws" 先頭。secret 開始 idx = 3 + gap。窓は slice(idx-200, idx+len+200)。
    // idx <= 200(gap <= 197)なら "aws" が前方窓に入る。
    const adoptedIn = `aws${' '.repeat(197)}${secret40}`; // idx = 200 → 採用
    const rejectedOut = `aws${' '.repeat(199)}${secret40}`; // idx = 202 → "aws" が窓から外れる
    expect(blockNames(adoptedIn)).toContain('aws-secret-access-key');
    expect(blockNames(rejectedOut)).not.toContain('aws-secret-access-key');
  });
});

describe('demoteIf によるプレースホルダ降格 (§13-7)', () => {
  it('api_key = "your_api_key_here" → block でなく warn', () => {
    const r = scanPii('api_key = "your_api_key_here"');
    expect(r.blocks.map((h) => h.pattern)).not.toContain('generic-secret-assignment');
    expect(r.warns.map((h) => h.pattern)).toContain('generic-secret-assignment');
  });

  it('api_key=xxxxxxxxxxxx → warn（同一文字の繰り返し）', () => {
    const r = scanPii('api_key=xxxxxxxxxxxx');
    expect(r.blocks).toHaveLength(0);
    expect(r.warns.map((h) => h.pattern)).toContain('generic-secret-assignment');
  });

  it('token: abcdef（12 文字未満）→ 検出なし（正規表現がそもそも非マッチ）', () => {
    const r = scanPii('token: abcdef');
    expect(r.blocks).toHaveLength(0);
    expect(r.warns).toHaveLength(0);
  });

  it('OpenAI 風プレースホルダ sk-your_... → warn 降格', () => {
    const r = scanPii('key = sk-your_api_key_here_xxxxx');
    expect(r.blocks.map((h) => h.pattern)).not.toContain('openai-key');
    expect(r.warns.map((h) => h.pattern)).toContain('openai-key');
  });

  it('isPlaceholder 単体', () => {
    expect(isPlaceholder('short')).toBe(true); // 12 文字未満
    expect(isPlaceholder('aaaaaaaaaaaaaa')).toBe(true); // 同一文字のみ
    expect(isPlaceholder('YOUR_secret_value')).toBe(true); // your_ (大小無視)
    expect(isPlaceholder('changeme_now_please')).toBe(true);
    expect(isPlaceholder('s3cr3tValue123456')).toBe(false);
  });
});

describe('WARN パターン (§13-7)', () => {
  it('メールアドレス → warn（block でない）', () => {
    const r = scanPii('連絡先は foo.bar@example.com です');
    expect(r.blocks).toHaveLength(0);
    expect(r.warns.map((h) => h.pattern)).toContain('email');
  });

  it('日本の携帯番号 → warn', () => {
    expect(warnNames('携帯 090-1234-5678')).toContain('phone-jp-mobile');
  });

  it('Luhn 通過 16 桁 → warn / 通過しない → credit-card は検出なし', () => {
    expect(warnNames('card 4242 4242 4242 4242')).toContain('credit-card');
    expect(warnNames('num 1234 5678 9012 3456')).not.toContain('credit-card');
  });

  it('郵便番号 → warn', () => {
    expect(warnNames('〒150-0001 東京')).toContain('jp-postal');
  });
});

describe('マスキングと生値の非流出 (§13-7)', () => {
  it('masked は先頭 4 文字 + *** で、生値は結果に含まれない', () => {
    const raw = 'AKIAIOSFODNN7EXAMPLE';
    const r = scanPii(`aws key ${raw}`);
    const hit = r.blocks.find((h) => h.pattern === 'aws-access-key-id');
    expect(hit?.masked).toBe('AKIA***');
    expect(JSON.stringify(r)).not.toContain(raw);
  });

  it('generic-secret-assignment はキャプチャ 1(値)をマスクする', () => {
    const r = scanPii('password = "s3cr3tValue123456"');
    const hit = r.blocks.find((h) => h.pattern === 'generic-secret-assignment');
    expect(hit?.masked).toBe('s3cr***');
    expect(JSON.stringify(r)).not.toContain('s3cr3tValue123456');
  });

  it('noteSlug / line が付与される', () => {
    const r = scanPii('line1\nline2 AKIAIOSFODNN7EXAMPLE', { noteSlug: 'my-note' });
    const hit = r.blocks.find((h) => h.pattern === 'aws-access-key-id');
    expect(hit?.noteSlug).toBe('my-note');
    expect(hit?.line).toBe(2);
  });
});

describe('冪等性・堅牢性 (§13-7)', () => {
  it('2 回連続呼び出しで同一結果（lastIndex 汚染なし）', () => {
    const text = 'AKIAIOSFODNN7EXAMPLE / foo@example.com / 090-1234-5678';
    expect(scanPii(text)).toEqual(scanPii(text));
  });

  it('空文字・非文字列 → 空結果', () => {
    expect(scanPii('')).toEqual({ blocks: [], warns: [] });
    expect(scanPii(undefined as unknown as string)).toEqual({ blocks: [], warns: [] });
  });

  it('1MB テキストでも現実的な時間で完了し結果が安定', () => {
    const big = `${'lorem ipsum dolor sit amet '.repeat(40000)}AKIAIOSFODNN7EXAMPLE`;
    const t0 = Date.now();
    const r1 = scanPii(big);
    const elapsed = Date.now() - t0;
    expect(r1.blocks.map((h) => h.pattern)).toContain('aws-access-key-id');
    expect(scanPii(big)).toEqual(r1);
    expect(elapsed).toBeLessThan(2000);
  });
});
