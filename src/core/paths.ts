// src/core/paths.ts — 全パスの単一の真実(設計書 §8-A / §1-2-1 / §10-3 / §4-1)。
//
// 他モジュールはここ以外でパスを組み立てない。projectRoot の解決もここに集約する。
// 依存は node:fs / node:path / node:crypto / node:os のみ(設計 §1-3)。

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MnemoError } from './errors.js';

/** `resolveProjectRoot` のオプション(設計 §8-A)。 */
export interface ResolveOpts {
  /** アンカー探索の起点。省略時は `process.cwd()`。 */
  startDir?: string;
  /** `--project <path>` 引数。指定時は探索より優先。 */
  projectFlag?: string;
}

/** 実在するパスは `realpathSync.native` で実体解決し、無ければ `path.resolve` にフォールバック。 */
function realOrResolve(p: string): string {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function hasConfig(root: string): boolean {
  return fs.existsSync(path.join(root, '.mnemotheca', 'config.json'));
}

const NOT_INITIALIZED_MSG =
  'このディレクトリ配下に Mnemotheca プロジェクトが見つかりません。npm init -y && npm install github:akilasatolu/mnemotheca#<tag> && npx mnemo init . を実行してください';

/**
 * projectRoot を解決する(設計 §1-2-1 / §8-A)。override → アンカー探索の順:
 *   1. `opts.projectFlag`(`--project`)があれば絶対化して採用
 *   2. `process.env.MNEMO_PROJECT` があれば採用
 *   3. それ以外: `findConfigAnchor(opts.startDir ?? process.cwd())`。null なら `NOT_INITIALIZED`
 * 1/2 の override 経路でも `<root>/.mnemotheca/config.json` の存在を確認する(無ければ `NOT_INITIALIZED`)。
 */
export function resolveProjectRoot(opts?: ResolveOpts): string {
  const override = opts?.projectFlag ?? process.env.MNEMO_PROJECT;
  if (override !== undefined && override !== '') {
    const root = realOrResolve(override);
    if (!hasConfig(root)) {
      throw new MnemoError('NOT_INITIALIZED', NOT_INITIALIZED_MSG, { projectRoot: root });
    }
    return root;
  }

  const anchor = findConfigAnchor(opts?.startDir ?? process.cwd());
  if (anchor === null) {
    throw new MnemoError('NOT_INITIALIZED', NOT_INITIALIZED_MSG);
  }
  return anchor;
}

/**
 * `mnemo init` 専用。探索も `config.json` 確認もしない。渡された cwd / `<dir>` をそのまま
 * projectRoot として絶対化して返す(設計 §8-A / §1-2-1)。
 */
export function resolveProjectRootForInit(cwdOrDir: string): string {
  return path.resolve(cwdOrDir);
}

/**
 * `startDir` から `path.parse(startDir).root` まで親方向へ 1 階層ずつ登り、最初に
 * `<dir>/.mnemotheca/config.json` が存在した `<dir>` を返す。無ければ null。
 * 起点は `realpathSync.native`(pnpm の symlink 実体化 / .pnpm / yarn PnP 対策)。
 * node_modules の位置・階層数には一切依存しない(設計 §8-A / §1-2-1)。
 */
export function findConfigAnchor(startDir: string): string | null {
  let dir = realOrResolve(startDir);
  // realpath 済みなので通常ディレクトリだが、ファイルを渡された場合に備えて dirname に寄せる。
  try {
    if (!fs.statSync(dir).isDirectory()) {
      dir = path.dirname(dir);
    }
  } catch {
    // 実在しない場合はそのまま親方向へ探索する。
  }

  for (;;) {
    if (hasConfig(dir)) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/**
 * `sha256(realpath(projectRoot)).slice(0, 16)`(設計 §8-A / §12-13 N-10)。
 * symlink 経由でも実体パス基準になるため、同一プロジェクトなら常に同一スロットになる。
 */
export function projectHash(projectRoot: string): string {
  return createHash('sha256').update(realOrResolve(projectRoot)).digest('hex').slice(0, 16);
}

/** `path.resolve` + 実在時は `realpathSync.native` + Windows は小文字化(設計 §8-A)。 */
export function normalizePath(p: string): string {
  const real = realOrResolve(p);
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

/** `<projectRoot>/.mnemotheca/` 配下のパス群(設計 §8-A。`<hash>` 階層は無い)。 */
export interface MnemothecaPaths {
  root: string;
  dir: string;
  configJson: string;
  indexDir: string;
  searchIndexJson: string;
  metaJson: string;
  conflictsJson: string;
  parseErrorsJson: string;
  usageLogJsonl: string;
  organizeSessionJson: string;
  snapshotsDir: string;
}

export function mnemothecaPaths(projectRoot: string): MnemothecaPaths {
  const root = path.resolve(projectRoot);
  const dir = path.join(root, '.mnemotheca');
  const indexDir = path.join(dir, 'index');
  return {
    root,
    dir,
    configJson: path.join(dir, 'config.json'),
    indexDir,
    searchIndexJson: path.join(indexDir, 'search-index.json'),
    metaJson: path.join(indexDir, 'meta.json'),
    conflictsJson: path.join(indexDir, 'conflicts.json'),
    parseErrorsJson: path.join(indexDir, 'parse-errors.json'),
    usageLogJsonl: path.join(indexDir, 'usage_log.jsonl'),
    organizeSessionJson: path.join(indexDir, 'organize-session.json'),
    snapshotsDir: path.join(dir, 'snapshots'),
  };
}

/** 揮発・非同期・現ユーザー専用(0700)のランタイム領域(設計 §8-A / §10-3)。 */
export interface RuntimePaths {
  base: string;
  dir: string;
  runJson: string;
  locksDir: string;
}

/** ディレクトリが「実在 + 書き込み可 + POSIX では自分所有」か。 */
function isUsableRuntimeDir(dir: string): boolean {
  try {
    const st = fs.statSync(dir);
    if (!st.isDirectory()) {
      return false;
    }
    fs.accessSync(dir, fs.constants.W_OK);
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

const RUNTIME_UNWRITABLE_MSG = (base: string): string =>
  `一時ディレクトリ \`${base}\` に書き込めません。MNEMO_RUNTIME_DIR で書き込み可能な場所を指定してください`;

/**
 * ランタイムベースの決定順(設計 §8-A):
 *   `MNEMO_RUNTIME_DIR`(set 時) > Linux の `XDG_RUNTIME_DIR`(set 時) > `os.tmpdir()`。
 * 各候補を「実在 + 書き込み可 + POSIX では自分所有」で検査し、ダメなら次へフォールスルー。
 * ただし `MNEMO_RUNTIME_DIR` が明示指定されていてダメなときだけは即 `RUNTIME_DIR_UNWRITABLE`。
 */
export function runtimeBase(): string {
  const candidates: Array<{ dir: string; explicit: boolean }> = [];

  const explicitDir = process.env.MNEMO_RUNTIME_DIR;
  if (explicitDir !== undefined && explicitDir !== '') {
    candidates.push({ dir: explicitDir, explicit: true });
  }
  if (process.platform === 'linux') {
    const xdg = process.env.XDG_RUNTIME_DIR;
    if (xdg !== undefined && xdg !== '') {
      candidates.push({ dir: xdg, explicit: false });
    }
  }
  candidates.push({ dir: os.tmpdir(), explicit: false });

  for (const c of candidates) {
    if (isUsableRuntimeDir(c.dir)) {
      return path.resolve(c.dir);
    }
    if (c.explicit) {
      throw new MnemoError('RUNTIME_DIR_UNWRITABLE', RUNTIME_UNWRITABLE_MSG(c.dir), { base: c.dir });
    }
  }

  const last = os.tmpdir();
  throw new MnemoError('RUNTIME_DIR_UNWRITABLE', RUNTIME_UNWRITABLE_MSG(last), { base: last });
}

/** `<runtimeBase>/mnemotheca/<projectHash>/`(設計 §8-A / §10-3)。内部で projectHash を計算。 */
export function runtimePaths(projectRoot: string): RuntimePaths {
  const base = runtimeBase();
  const dir = path.join(base, 'mnemotheca', projectHash(projectRoot));
  return {
    base,
    dir,
    runJson: path.join(dir, 'run.json'),
    locksDir: path.join(dir, 'locks'),
  };
}

/**
 * `<runtimeBase>/mnemotheca/<projectHash>/` を `0o700` で用意する(設計 §8-A セキュリティ)。
 * base の選択に関わらず、生成した `<projectHash>` ディレクトリが group/other にアクセス可
 * (`0o077` ビットを含む)なら `0o700` に矯正する。
 * mkdir が EACCES/EROFS/ENOSPC → `MnemoError(RUNTIME_DIR_UNWRITABLE, { base })`。
 * 返り値 = `runtimePaths(projectRoot).dir`。
 */
export async function ensureRuntimeDir(projectRoot: string): Promise<string> {
  const { base, dir } = runtimePaths(projectRoot);
  try {
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    const st = await fs.promises.stat(dir);
    if ((st.mode & 0o077) !== 0) {
      await fs.promises.chmod(dir, 0o700);
    }
    return dir;
  } catch (err) {
    if (err instanceof MnemoError) {
      throw err;
    }
    throw new MnemoError('RUNTIME_DIR_UNWRITABLE', RUNTIME_UNWRITABLE_MSG(base), { base });
  }
}

/** vault 配下のパス群。常に `<projectRoot>/vault` 配下(設計 §8-A / §4-1)。 */
export interface VaultPaths {
  root: string;
  knowledgeDir: string;
  categoriesDir: string;
  uncategorizedDir: string;
  markerJson: string;
}

export function vaultPaths(projectRoot: string): VaultPaths {
  const root = path.join(path.resolve(projectRoot), 'vault');
  const knowledgeDir = path.join(root, 'knowledge');
  return {
    root,
    knowledgeDir,
    categoriesDir: path.join(root, 'categories'),
    uncategorizedDir: path.join(knowledgeDir, '_uncategorized'),
    markerJson: path.join(root, '.mnemotheca-vault.json'),
  };
}
