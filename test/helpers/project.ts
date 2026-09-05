import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 設計 §13 冒頭「テストの隔離(共通)」。
 *
 * `os.tmpdir()` 配下に mkdtemp で隔離された projectRoot を 1 つ作り、`.mnemotheca/` の
 * 初期状態と `vault/` のレイアウトを整える。全状態は projectRoot 配下(と
 * `<runtimeBase>/mnemotheca/<projectHash>/`)に閉じるため、グローバル状態や環境変数の
 * 差し替えは不要。`projectHash = sha256(realpath(projectRoot))` が mkdtemp のランダム名で
 * 一意になるので、ランタイム側スロットもテストごとに自動的に分離される。
 *
 * afterEach では返った root を `fs.rmSync(root, { recursive: true, force: true })` で削除する
 * (ランタイム側スロットの掃除は `runtime.ts` の `withRuntimeDir()` / `cleanRuntimeDir()` を使う)。
 */
export async function makeProject(): Promise<string> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mnemo-proj-'));
  const now = new Date().toISOString();

  await fs.promises.mkdir(path.join(root, '.mnemotheca', 'index'), { recursive: true });
  await fs.promises.mkdir(path.join(root, 'vault', 'knowledge'), { recursive: true });
  await fs.promises.mkdir(path.join(root, 'vault', 'categories'), { recursive: true });

  await fs.promises.writeFile(
    path.join(root, '.mnemotheca', 'config.json'),
    `${JSON.stringify({ v: 1, createdAt: now, updatedAt: now }, null, 2)}\n`,
  );
  await fs.promises.writeFile(
    path.join(root, 'vault', '.mnemotheca-vault.json'),
    `${JSON.stringify({ v: 1, createdAt: now }, null, 2)}\n`,
  );

  return root;
}

/**
 * 設計 §13 冒頭 / §13-16 — `git clone` 直後の状態を再現する。
 *
 * `node_modules/` と `.mnemotheca/index/` `.mnemotheca/snapshots/` を削除する
 * (= clone 直後。`.mnemotheca/config.json` と `vault/` は git 追跡対象として残る)。
 * 復旧テストで `npm install`(モック)+ `mnemo reindex` により状態が復元することを検証する。
 * 対象が存在しなくてもエラーにしない(冪等)。
 */
export function simulateCloneState(root: string): void {
  for (const rel of ['node_modules', path.join('.mnemotheca', 'index'), path.join('.mnemotheca', 'snapshots')]) {
    fs.rmSync(path.join(root, rel), { recursive: true, force: true });
  }
}
