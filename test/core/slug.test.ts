import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isMnemoError } from '../../src/core/errors.js';
import { ID_PATTERN, newId } from '../../src/core/id.js';
import {
  isValidSlug,
  resolveCollision,
  SLUG_MAX_LENGTH,
  toSlug,
} from '../../src/core/slug.js';

// slug のテストに加え、密接に関連する core/id.ts のテストも同じファイルにまとめている。

describe('toSlug (§8-E / §13-3)', () => {
  it('日本語混在タイトル → 英字のみの slug', () => {
    expect(toSlug('AWS 上での MCP')).toBe('aws-mcp');
  });

  it('日本語のみ → 基底 "note"', () => {
    expect(toSlug('機械学習ノート')).toBe('note');
    expect(toSlug('   ')).toBe('note');
    expect(toSlug('')).toBe('note');
  });

  it('連続する非英数字を 1 個のハイフンに圧縮し前後ハイフンを除去', () => {
    expect(toSlug('  Hello --- World!!!  ')).toBe('hello-world');
    expect(toSlug('a___b...c')).toBe('a-b-c');
    expect(toSlug('--edge--')).toBe('edge');
  });

  it('NFKC 正規化 + 小文字化(全角英数字)', () => {
    expect(toSlug('ＡＷＳ　ＭＣＰ')).toBe('aws-mcp');
  });

  it('60 字を超えるタイトルは 60 字以内に切り詰め、末尾ハイフンを残さない', () => {
    const long = `${'ab '.repeat(40)}`; // "ab ab ab ..." → "ab-ab-..."
    const slug = toSlug(long);
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith('-')).toBe(false);
    expect(slug.startsWith('-')).toBe(false);
    expect(isValidSlug(slug)).toBe(true);
  });

  it('切り詰め境界でハイフンが末尾に来るケースでもトリムされる', () => {
    // 59 文字の英数字 + スペース + 文字 → 60 でスライスするとスペース由来の "-" が末尾に来る
    const title = `${'a'.repeat(59)} b`;
    const slug = toSlug(title);
    expect(slug).toBe('a'.repeat(59));
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('isValidSlug (§8-E / §13-3)', () => {
  it('正常な slug を許可する', () => {
    expect(isValidSlug('aws-mcp')).toBe(true);
    expect(isValidSlug('note')).toBe(true);
    expect(isValidSlug('a1-b2-c3')).toBe(true);
    expect(isValidSlug('x')).toBe(true);
  });

  it('大文字・アンダースコアを拒否する', () => {
    expect(isValidSlug('AWS_MCP')).toBe(false);
    expect(isValidSlug('AWS-MCP')).toBe(false);
    expect(isValidSlug('aws_mcp')).toBe(false);
  });

  it('先頭・末尾ハイフン、連続ハイフンを拒否する', () => {
    expect(isValidSlug('-abc')).toBe(false);
    expect(isValidSlug('abc-')).toBe(false);
    expect(isValidSlug('a--b')).toBe(false);
  });

  it('空文字・空白・日本語を拒否する', () => {
    expect(isValidSlug('')).toBe(false);
    expect(isValidSlug(' ')).toBe(false);
    expect(isValidSlug('機械学習')).toBe(false);
  });

  it('長さ境界: 80 字 OK / 81 字 NG', () => {
    expect(isValidSlug('a'.repeat(SLUG_MAX_LENGTH))).toBe(true);
    expect(isValidSlug('a'.repeat(SLUG_MAX_LENGTH + 1))).toBe(false);
  });
});

describe('resolveCollision (§8-E / §13-3)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mnemo-slug-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const touch = async (name: string): Promise<void> => {
    await fs.promises.writeFile(path.join(dir, name), '');
  };

  it('衝突なし → action:create で <slug>.md', async () => {
    for (const strategy of ['auto-number', 'append-to-existing', 'abort'] as const) {
      const r = await resolveCollision(dir, 'aws-mcp', strategy);
      expect(r).toEqual({ action: 'create', absPath: path.join(dir, 'aws-mcp.md') });
    }
  });

  it('auto-number: slug.md / slug-2.md 既存 → slug-3.md', async () => {
    await touch('aws-mcp.md');
    await touch('aws-mcp-2.md');
    const r = await resolveCollision(dir, 'aws-mcp', 'auto-number');
    expect(r).toEqual({ action: 'create', absPath: path.join(dir, 'aws-mcp-3.md') });
  });

  it('auto-number: slug.md のみ既存 → slug-2.md', async () => {
    await touch('note.md');
    const r = await resolveCollision(dir, 'note', 'auto-number');
    expect(r.absPath).toBe(path.join(dir, 'note-2.md'));
  });

  it('auto-number: 連番付与後も 80 文字を超えないよう基底を切り詰める', async () => {
    const slug = 'a'.repeat(80);
    await touch(`${slug}.md`);
    const r = await resolveCollision(dir, slug, 'auto-number');
    const base = path.basename(r.absPath, '.md');
    expect(base.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
    expect(base).toBe(`${'a'.repeat(78)}-2`);
  });

  it('append-to-existing: 既存あり → action:append で既存パス', async () => {
    await touch('aws-mcp.md');
    const r = await resolveCollision(dir, 'aws-mcp', 'append-to-existing');
    expect(r).toEqual({ action: 'append', absPath: path.join(dir, 'aws-mcp.md') });
  });

  it('abort: 既存あり → MnemoError(SLUG_COLLISION)', async () => {
    await touch('aws-mcp.md');
    const err = await resolveCollision(dir, 'aws-mcp', 'abort').catch((e: unknown) => e);
    expect(isMnemoError(err)).toBe(true);
    expect(isMnemoError(err) && err.code).toBe('SLUG_COLLISION');
  });
});

describe('newId (§8-F / §10-2-4 / §13-3)', () => {
  it('ID_PATTERN にマッチする', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(newId()).toMatch(ID_PATTERN);
      expect(newId()).toMatch(/^[0-9]{8}T[0-9]{9}[a-z0-9]{5}$/);
    }
  });

  it('固定 Date からタイムスタンプ部を組み立てる(コロン無し・ローカル時刻)', () => {
    const d = new Date(2026, 8, 1, 9, 30, 15, 123); // 2026-09-01 09:30:15.123 local
    const id = newId(d);
    expect(id.slice(0, 18)).toBe('20260901T093015123');
    expect(id).toMatch(ID_PATTERN);
  });

  it('同一 Date で 1000 回呼んでも全てユニーク', () => {
    const d = new Date(2026, 0, 2, 3, 4, 5, 6);
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      ids.add(newId(d));
    }
    expect(ids.size).toBe(1000);
    for (const id of ids) {
      expect(id).toMatch(ID_PATTERN);
    }
  });

  it('レキシカルソート = 時刻順', () => {
    const dates = [
      new Date(2025, 0, 1, 0, 0, 0, 0),
      new Date(2026, 8, 1, 9, 30, 15, 123),
      new Date(2026, 8, 1, 9, 30, 16, 0),
      new Date(2027, 11, 31, 23, 59, 59, 999),
    ];
    const ids = dates.map((d) => newId(d));
    const shuffled = [ids[3], ids[0], ids[2], ids[1]] as string[];
    expect([...shuffled].sort()).toEqual(ids);
  });
});
