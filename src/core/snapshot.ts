// src/core/snapshot.ts — organize の変更前スナップショット / 世代 GC / undo(設計書 §8-H)。
//
// 方式は「影響ファイルのみの全コピー」(ハードリンク不使用・クロスデバイス対応)。
// スナップショットは `<projectRoot>/.mnemotheca/snapshots/<label>-<ts>/` 配下に永続化する
// (undo が再起動を跨いで効くように、tmp ランタイム領域ではなく projectRoot 内。§4-1)。
//
// 依存は node 標準 + core/errors・core/paths のみ(設計 §1-3)。ロック取得は呼び出し側
// (§8-N apply)が `withLock(projectRoot, 'vault')` の内側でこのモジュールを呼ぶ責務。

import fs from 'node:fs';
import path from 'node:path';
import { MnemoError } from './errors.js';
import { mnemothecaPaths, vaultPaths } from './paths.js';

/** 保持するスナップショット世代数(設計 §8-H)。 */
export const SNAPSHOT_KEEP = 5;

/** スナップショット 1 件の manifest(設計書 §8-H)。 */
export interface SnapshotManifest {
  v: 1;
  /** Claude 指定のラベル or `'organize'`。 */
  label: string;
  createdAt: string;
  /** 適用予定 proposalId 一覧(監査用)。 */
  operations: string[];
  files: {
    /** vault ルート相対・POSIX 区切り(`knowledge/...`)。 */
    relPath: string;
    state: 'modified' | 'deleted' | 'moved-from';
    /** snapshot ディレクトリ内の相対パス(`files/knowledge/...`)。 */
    savedAs: string;
  }[];
  /** apply で新規作成されたファイルの relPath(undo で unlink する)。 */
  created: string[];
}

/** `listSnapshots` の 1 エントリ(設計書 §8-H)。 */
export interface SnapshotInfo {
  id: string;
  label: string;
  createdAt: string;
  fileCount: number;
}

const MANIFEST_NAME = 'manifest.json';
const FILES_SUBDIR = 'files';

function toPosix(rel: string): string {
  return rel.split(path.sep).join('/');
}

function fromPosix(rel: string): string[] {
  return rel.split('/').filter((s) => s !== '' && s !== '.');
}

/** 同一プロセス内で連続作成しても `createdAt` が単調増加するようにするための番人。 */
let lastStampMs = 0;
function monotonicNow(): Date {
  let ms = Date.now();
  if (ms <= lastStampMs) {
    ms = lastStampMs + 1;
  }
  lastStampMs = ms;
  return new Date(ms);
}

/** `<label>-<ISO(コロン・ドットをハイフンへ)>`。既存と衝突したら連番を足して一意化する。 */
function allocSnapshotId(snapshotsDir: string, label: string, now: Date): string {
  const ts = now.toISOString().replace(/[:.]/g, '-');
  const base = `${label}-${ts}`;
  let id = base;
  let n = 1;
  while (fs.existsSync(path.join(snapshotsDir, id))) {
    n += 1;
    id = `${base}-${n}`;
  }
  return id;
}

async function readManifest(projectRoot: string, snapId: string): Promise<SnapshotManifest> {
  const { snapshotsDir } = mnemothecaPaths(projectRoot);
  const manifestPath = path.join(snapshotsDir, snapId, MANIFEST_NAME);
  let raw: string;
  try {
    raw = await fs.promises.readFile(manifestPath, 'utf8');
  } catch {
    throw new MnemoError(
      'SNAPSHOT_FAILED',
      `スナップショット \`${snapId}\` が見つかりません`,
      { snapshotDir: path.join(snapshotsDir, snapId) },
    );
  }
  try {
    return JSON.parse(raw) as SnapshotManifest;
  } catch {
    throw new MnemoError(
      'SNAPSHOT_FAILED',
      `スナップショット \`${snapId}\` の manifest.json が壊れています`,
      { snapshotDir: path.join(snapshotsDir, snapId) },
    );
  }
}

async function writeManifest(
  projectRoot: string,
  snapId: string,
  manifest: SnapshotManifest,
): Promise<void> {
  const { snapshotsDir } = mnemothecaPaths(projectRoot);
  const dir = path.join(snapshotsDir, snapId);
  const manifestPath = path.join(dir, MANIFEST_NAME);
  const tmp = path.join(dir, `.${MANIFEST_NAME}.tmp`);
  await fs.promises.writeFile(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await fs.promises.rename(tmp, manifestPath);
}

/** 空になった祖先ディレクトリを vault ルートまで(ルートは残す)掃除する。 */
async function pruneEmptyDirs(startDir: string, stopDir: string): Promise<void> {
  let dir = startDir;
  while (dir.startsWith(stopDir) && dir !== stopDir) {
    let entries: string[];
    try {
      entries = await fs.promises.readdir(dir);
    } catch {
      return;
    }
    if (entries.length > 0) {
      return;
    }
    try {
      await fs.promises.rmdir(dir);
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}

/**
 * 影響ファイルのみをコピーしたスナップショットを作成する(設計書 §8-H)。
 *
 * - `<snapshotsDir>/<label>-<ts>/files/<vault 相対パス>` に現ファイルをコピー(vault の
 *   ディレクトリ構造を再現)。存在しない `affectedRelPaths`(これから新規作成されるもの)は
 *   スキップし、`finalizeSnapshotManifest({ created })` で後追い記録する。
 * - `manifest.json` を書く。`files[]` は `state:'modified'` で初期化、`created` は空。
 * - コピー中の失敗(ディスクフルなど)は部分生成物を掃除して `SNAPSHOT_FAILED` を投げる
 *   (vault には一切書き込まないので vault は無変更)。
 *
 * @returns スナップショット ID(`<label>-<ts>`)。
 */
export async function createSnapshot(
  projectRoot: string,
  label: string,
  affectedRelPaths: string[],
  operations: string[] = [],
): Promise<string> {
  const { snapshotsDir } = mnemothecaPaths(projectRoot);
  const vaultRoot = vaultPaths(projectRoot).root;

  await fs.promises.mkdir(snapshotsDir, { recursive: true });
  const now = monotonicNow();
  const snapId = allocSnapshotId(snapshotsDir, label, now);
  const snapDir = path.join(snapshotsDir, snapId);

  try {
    await fs.promises.mkdir(path.join(snapDir, FILES_SUBDIR), { recursive: true });

    const files: SnapshotManifest['files'] = [];
    // 重複を排除しつつ順序は維持する。
    const seen = new Set<string>();
    for (const rawRel of affectedRelPaths) {
      const relPath = toPosix(rawRel);
      if (seen.has(relPath)) {
        continue;
      }
      seen.add(relPath);

      const src = path.join(vaultRoot, ...fromPosix(relPath));
      if (!fs.existsSync(src)) {
        // まだ存在しない(= これから created 予定)ファイルはコピー対象外。
        continue;
      }
      const savedAsRel = `${FILES_SUBDIR}/${relPath}`;
      const dest = path.join(snapDir, ...fromPosix(savedAsRel));
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await fs.promises.copyFile(src, dest);
      files.push({ relPath, state: 'modified', savedAs: savedAsRel });
    }

    const manifest: SnapshotManifest = {
      v: 1,
      label,
      createdAt: now.toISOString(),
      operations,
      files,
      created: [],
    };
    await writeManifest(projectRoot, snapId, manifest);
    return snapId;
  } catch (err) {
    // 部分生成物を掃除(vault は無変更なのでロールバック不要)。
    await fs.promises.rm(snapDir, { recursive: true, force: true }).catch(() => {});
    if (err instanceof MnemoError) {
      throw err;
    }
    throw new MnemoError(
      'SNAPSHOT_FAILED',
      `スナップショットの作成に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
      { snapshotDir: snapDir },
    );
  }
}

/**
 * apply 完了後、新規作成・削除の実績を manifest に反映する(設計書 §8-H)。
 * - `patch.created`   → `manifest.created` に追記(undo で unlink)。
 * - `patch.deletions` → 対応する `files[]` エントリの `state` を `'modified'` → `'deleted'` に更新。
 *   (createSnapshot 時点で影響ファイルとして savedAs にコピー済みなので、undo は書き戻すだけ)
 */
export async function finalizeSnapshotManifest(
  projectRoot: string,
  snapId: string,
  patch: { created?: string[]; deletions?: string[] },
): Promise<void> {
  const manifest = await readManifest(projectRoot, snapId);

  if (patch.created && patch.created.length > 0) {
    const existing = new Set(manifest.created);
    for (const rel of patch.created) {
      const relPath = toPosix(rel);
      if (!existing.has(relPath)) {
        existing.add(relPath);
        manifest.created.push(relPath);
      }
    }
  }

  if (patch.deletions && patch.deletions.length > 0) {
    const del = new Set(patch.deletions.map(toPosix));
    for (const entry of manifest.files) {
      if (del.has(entry.relPath)) {
        entry.state = 'deleted';
      }
    }
  }

  await writeManifest(projectRoot, snapId, manifest);
}

/**
 * スナップショットを vault へ復元する(設計書 §8-H)。
 *
 * - `files[]`(`modified` / `deleted` / `moved-from`)→ `savedAs` から元 `relPath` へ書き戻し(mkdir -p)。
 * - `created`   → 実ファイルを削除(ENOENT は握りつぶす)。空になったディレクトリを掃除。
 *
 * **再入可能(idempotent)**: 同じ `snapId` で複数回呼んでも安全。
 * - `created` の unlink は ENOENT を握りつぶす(既に消えていてよい)。
 * - `files[]` の書き戻しは savedAs から同一内容の上書きなので何度やっても同じ結果。
 * クラッシュ復帰(§8-N undo)で 2 回走る経路があるため必須。
 */
export async function restoreSnapshot(projectRoot: string, snapId: string): Promise<void> {
  const { snapshotsDir } = mnemothecaPaths(projectRoot);
  const snapDir = path.join(snapshotsDir, snapId);
  const vaultRoot = vaultPaths(projectRoot).root;
  const manifest = await readManifest(projectRoot, snapId);

  for (const entry of manifest.files) {
    const saved = path.join(snapDir, ...fromPosix(entry.savedAs));
    const target = path.join(vaultRoot, ...fromPosix(entry.relPath));
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    // savedAs → 元パスへ同一内容上書き(冪等)。
    await fs.promises.copyFile(saved, target);
  }

  for (const rel of manifest.created) {
    const target = path.join(vaultRoot, ...fromPosix(rel));
    try {
      await fs.promises.unlink(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
      // 既に消えている(再入)のは正常。
    }
    await pruneEmptyDirs(path.dirname(target), vaultRoot);
  }
}

/** スナップショット一覧を `createdAt` 降順で返す(設計書 §8-H)。 */
export async function listSnapshots(projectRoot: string): Promise<SnapshotInfo[]> {
  const { snapshotsDir } = mnemothecaPaths(projectRoot);
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(snapshotsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const infos: SnapshotInfo[] = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) {
      continue;
    }
    try {
      const manifest = await readManifest(projectRoot, ent.name);
      infos.push({
        id: ent.name,
        label: manifest.label,
        createdAt: manifest.createdAt,
        fileCount: manifest.files.length + manifest.created.length,
      });
    } catch {
      // manifest 欠落・破損のディレクトリは一覧から除外する。
    }
  }

  infos.sort((a, b) => {
    if (a.createdAt !== b.createdAt) {
      return a.createdAt < b.createdAt ? 1 : -1;
    }
    return a.id < b.id ? 1 : -1;
  });
  return infos;
}

/**
 * `createdAt` 降順で `keep` 件残し、それより古い世代を削除する(設計書 §8-H)。
 * 各 apply の最後に `gcSnapshots(projectRoot, SNAPSHOT_KEEP)` を呼ぶ。
 */
export async function gcSnapshots(projectRoot: string, keep: number = SNAPSHOT_KEEP): Promise<void> {
  const { snapshotsDir } = mnemothecaPaths(projectRoot);
  const infos = await listSnapshots(projectRoot);
  const doomed = infos.slice(Math.max(0, keep));
  for (const info of doomed) {
    await fs.promises.rm(path.join(snapshotsDir, info.id), { recursive: true, force: true });
  }
}
