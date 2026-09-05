// src/cli/wizard.ts — `mnemo init`(§9-4)の対話プロンプト層。
//
// `init.ts` の 9 ステップから呼ばれる「はい/いいえ」確認だけを担う。本体パス・
// ナレッジ保管パスの入力は存在しない(位置は固定・設計 §9-4)。
//
// - 実プロンプトは `@inquirer/prompts` の `confirm` を **遅延 import** で使う。
// - 非対話(stdin が TTY でない = CI やパイプ経由の実行、テストなど)では確認を出さず既定値を返す。
// - テストは `WizardPrompts` をまるごと差し替える(実プロンプトを起動しない)。

/** `init` が必要とする確認プロンプト群(テストで注入差し替え可能)。 */
export interface WizardPrompts {
  /** 空でない既存ディレクトリを projectRoot に使ってよいか(既定 true)。 */
  confirmUseExistingDir(dir: string): Promise<boolean>;
  /** `vault/knowledge/` に既存 `.md` を検出。そのまま使ってよいか(既定 true)。 */
  confirmUseExistingVault(noteCount: number): Promise<boolean>;
}

/** stdin が対話端末なら `@inquirer/prompts` の `confirm`、非対話なら `fallback` を返す。 */
async function ask(message: string, fallback: boolean): Promise<boolean> {
  if (process.stdin.isTTY !== true) {
    return fallback;
  }
  try {
    const { confirm } = await import('@inquirer/prompts');
    return await confirm({ message, default: fallback });
  } catch {
    // Ctrl+C / 端末喪失などは既定値で継続する(init を止めない)。
    return fallback;
  }
}

/** 既定のプロンプト実装(実運用で使われる)。 */
export const defaultPrompts: WizardPrompts = {
  confirmUseExistingDir: (dir: string): Promise<boolean> =>
    ask(`${dir} は空ではありません。このディレクトリを projectRoot として使いますか?`, true),
  confirmUseExistingVault: (noteCount: number): Promise<boolean> =>
    ask(
      `既存の vault を検出しました(ノート ${noteCount} 件)。このまま使いますか?`,
      true,
    ),
};
