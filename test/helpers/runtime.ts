import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 設計 §8-A / §13-4 — `runtimeBase()` は `MNEMO_RUNTIME_DIR` を最優先で見る。
 *
 * 通常のテストでは差し替え不要(mkdtemp のランダム名で projectHash が一意になるため)だが、
 * パーミッション/モード検証など「ランタイム領域そのもの」を対象にするテストでは、
 * `MNEMO_RUNTIME_DIR` を専用の隔離ディレクトリへ向ける。
 */
export interface RuntimeDirHandle {
  /** `MNEMO_RUNTIME_DIR` に設定された隔離ディレクトリの絶対パス。 */
  readonly dir: string;
  /** 環境変数を元に戻し、隔離ディレクトリを削除する。 */
  restore(): void;
}

/**
 * `MNEMO_RUNTIME_DIR` を新しい mkdtemp ディレクトリに差し替える。
 * `dir` を任意指定すると既存ディレクトリ(例: 非書き込み可の probe 用)を使う。
 * 返り値の `restore()` を afterEach で呼ぶこと。
 */
export function withRuntimeDir(dir?: string): RuntimeDirHandle {
  const previous = process.env.MNEMO_RUNTIME_DIR;
  const target = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'mnemo-rt-'));
  const owned = dir === undefined;
  process.env.MNEMO_RUNTIME_DIR = target;

  return {
    dir: target,
    restore(): void {
      if (previous === undefined) {
        delete process.env.MNEMO_RUNTIME_DIR;
      } else {
        process.env.MNEMO_RUNTIME_DIR = previous;
      }
      if (owned) {
        fs.rmSync(target, { recursive: true, force: true });
      }
    },
  };
}

/**
 * projectRoot に対応するランタイム側スロット
 * (`<runtimeBase>/mnemotheca/<projectHash>/`)を掃除するヘルパ。
 * `runtimeBase()` 実装が入るまでは `MNEMO_RUNTIME_DIR` 配下を丸ごと削除するだけの近似。
 */
export function cleanRuntimeDir(): void {
  const base = process.env.MNEMO_RUNTIME_DIR;
  if (base && base.includes('mnemo-rt-')) {
    fs.rmSync(base, { recursive: true, force: true });
  }
}
