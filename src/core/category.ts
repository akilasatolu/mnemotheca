// src/core/category.ts — カテゴリ名の単一セグメント検証と、`categories[0]` と実ディレクトリの
// 不変条件チェック(設計書 §10-2-3)。
//
// I/O は行わない。パスの組み立ては core/paths.ts に集約する。

import path from 'node:path';
import { MnemoError } from './errors.js';
import type { Frontmatter } from './frontmatter.js';
import { vaultPaths } from './paths.js';

/**
 * カテゴリ名が「単一セグメント」か(設計書 §10-2-3 条件 2 / §8-M)。
 * スラッシュ・バックスラッシュ・`.` / `..`・空文字・NUL を含まないこと。
 */
export function isSingleSegment(s: string): boolean {
  return (
    s.length > 0 &&
    !s.includes('/') &&
    !s.includes('\\') &&
    !s.includes('\0') &&
    s !== '.' &&
    s !== '..'
  );
}

/** `assertCategoryPathInvariant` のオプション。 */
export interface CategoryInvariantOptions {
  /**
   * store 経路(`mnemo_store`)では `true`。`categories[0]` が単一セグメントであることを
   * 追加で強制する(設計書 §10-2-3 条件 2)。organize / reindex 経路では `false`(多階層可)。
   */
  requireSingleSegment?: boolean;
}

/**
 * `categories[0]` の不変条件を強制する(設計書 §10-2-3)。
 *
 * 1. `path.relative(knowledgeDir, dirname(absPath))` を POSIX 化した文字列 === `categories[0]`
 * 2. store 経路では追加で `categories[0]` が単一セグメント(`requireSingleSegment`)
 * 3. `categories[0]` に `..` / 先頭 `/` / 空文字が無い
 *
 * 違反 → `MnemoError('CATEGORY_INVARIANT', ..., { expected, actual })`。
 * store の apply・organize の apply・reindex の parse 時に検査する。
 */
export function assertCategoryPathInvariant(
  fm: Frontmatter,
  absPath: string,
  projectRoot: string,
  options: CategoryInvariantOptions = {},
): void {
  const cat0 = fm.categories[0];

  // 条件 3: `..` / 先頭 `/` / 空文字の禁止
  const segments = cat0 === undefined ? [] : cat0.split(/[/\\]/);
  if (
    cat0 === undefined ||
    cat0 === '' ||
    cat0.startsWith('/') ||
    cat0.startsWith('\\') ||
    segments.includes('..') ||
    segments.includes('.') ||
    segments.some((s) => s === '')
  ) {
    throw new MnemoError('CATEGORY_INVARIANT', 'categories[0] が不正なパスです', {
      expected: '相対セグメント(先頭 / なし・.. なし・空セグメントなし)',
      actual: cat0 ?? null,
    });
  }

  // 条件 1: 実ディレクトリ(knowledge/ 相対・POSIX)と一致すること
  const knowledgeDir = vaultPaths(projectRoot).knowledgeDir;
  const relDir = path.relative(knowledgeDir, path.dirname(absPath));
  const relPosix = relDir.split(path.sep).join('/');
  if (relPosix !== cat0) {
    throw new MnemoError('CATEGORY_INVARIANT', 'categories[0] が実ディレクトリと一致しません', {
      expected: relPosix,
      actual: cat0,
    });
  }

  // 条件 2: store 経路は単一セグメント
  if (options.requireSingleSegment && !isSingleSegment(cat0)) {
    throw new MnemoError(
      'CATEGORY_INVARIANT',
      'store 経路では categories[0] は単一セグメントである必要があります',
      { expected: '単一セグメント', actual: cat0 },
    );
  }
}
