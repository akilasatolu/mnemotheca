// src/cli/commands/init.ts — `mnemo init`(§9-4 ブートストラップ + ウィザード)。
//
// 新フロー(ユーザーが自分の別ディレクトリに `mnemo` を npm 依存としてインストールして使う方式。
// `mkdir ~/mnemo && cd ~/mnemo && npm init -y && npm install github:<slug>#<tag>` の後に
// `npx mnemo init .` が呼ばれる想定):
//   1. Node < 20 → エラー終了
//   2. projectRoot 決定(`resolveProjectRootForInit`。<dir> 引数 or cwd)
//   3. インストール検証: `node_modules/mnemo/dist/cli/index.js` と
//      `node_modules/mnemo/dist/mcp/index.js` の両方が無ければ「npm install がまだ」の
//      エラーで中断(`mnemo init` 自身は `package.json` 生成も `npm install` 実行もしない)
//   4. `.gitignore` 生成(既存の `mergeGitignore` ロジックを流用・変更なし)
//   5. `.mnemotheca/config.json` + `vault/{knowledge,categories,.mnemotheca-vault.json}`
//   6. 初回 buildIndex(失敗は warn + 続行)
//   7. MCP スニペット出力(`buildMcpSnippet`)+ 貼り付け先案内 + 次アクション
//
// fs・prompt はすべて `InitDeps` 経由で差し替え可能
// (テストは実 `npm install`/ネットワークを絶対にしない)。

import fs from 'node:fs';
import path from 'node:path';

import { buildMcpSnippet as realBuildMcpSnippet } from '../../core/mcp-snippet.js';
import { regenerateCategories as realRegenerateCategories } from '../../core/categories-index.js';
import { buildIndex as realBuildIndex } from '../../core/search.js';
import { writeVaultMarker } from '../../core/config.js';
import { MnemoError } from '../../core/errors.js';
import { resolveProjectRootForInit, vaultPaths, mnemothecaPaths } from '../../core/paths.js';
import type { CliCommandContext } from '../index.js';
import * as ui from '../ui.js';
import { defaultPrompts, type WizardPrompts } from '../wizard.js';

/**
 * 公開リポジトリ https://github.com/akilasatolu/mnemotheca の `<org>/<repo>`。
 * 案内文・エラーメッセージでの clone 手順表示に使う。リポジトリを移動する場合は
 * この定数だけ差し替える。
 */
export const MNEMO_GITHUB_SLUG = 'akilasatolu/mnemotheca';

/** `mnemo init` の注入ポイント。省略時は実実装(テストは必ずここを差し替える)。 */
export interface InitDeps {
  /** 位置引数 `<dir>` の解決起点。省略時 `process.cwd()`。 */
  cwd?: string;
  /** Node バージョン文字列。省略時 `process.version`。 */
  nodeVersion?: string;
  /** 初回インデックス構築。省略時 `core/search.buildIndex`。 */
  buildIndex?: (projectRoot: string) => Promise<unknown>;
  /** カテゴリ一覧再生成。省略時 `core/categories-index.regenerateCategories`。 */
  regenerateCategories?: (projectRoot: string) => Promise<unknown>;
  /** MCP スニペット生成。省略時 `core/mcp-snippet.buildMcpSnippet`。 */
  buildMcpSnippet?: typeof realBuildMcpSnippet;
  /** 確認プロンプト群。省略時は `wizard.defaultPrompts`。 */
  prompts?: WizardPrompts;
  /** 現在時刻。省略時 `() => new Date()`。 */
  now?: () => Date;
  /** stdout への書き込み。省略時 `process.stdout.write`。 */
  out?: (chunk: string) => void;
}

/**
 * `mnemo init` が管理する `.gitignore` ブロック(設計 §4-1 / §9-4 step5)。
 *
 * 2 本のマーカーで囲んだこの範囲だけを init が書き換える。マーカーの外に
 * ユーザーが足したルールは保持する。狙いは「`vault/` と
 * `.mnemotheca/config.json` だけを追跡し、再インストールで戻せるもの
 * (`node_modules/` / 派生インデックス / スナップショット)は追跡しない」。
 */
const GITIGNORE_BEGIN = '# >>> mnemo (managed by `mnemo init` — edit outside this block) >>>';
const GITIGNORE_END = '# <<< mnemo <<<';
const GITIGNORE_BODY: readonly string[] = [
  '/*',
  '!/vault/',
  '!/.gitignore',
  '!/.mnemotheca/',
  '/.mnemotheca/index/',
  '/.mnemotheca/snapshots/',
];

/** 現行の管理ブロック文字列(末尾改行なし)。 */
function renderGitignoreBlock(): string {
  return [GITIGNORE_BEGIN, ...GITIGNORE_BODY, GITIGNORE_END].join('\n');
}

/**
 * `.gitignore` の生内容に管理ブロックを反映した結果を返す純関数。
 * - 既存ブロックがあれば中身を現行版へ置換(マーカー外は不変)
 * - 無ければ先頭に挿入し、既存行はブロックの後ろへ温存(`/*` の後なので
 *   ユーザーの `!...` 追記も効く)
 * - 空 / 未存在ならブロックのみ
 * 冪等: 戻り値が入力と一致するなら書き込み不要。
 */
export function mergeGitignore(raw: string): string {
  const block = renderGitignoreBlock();
  const lines = raw.split(/\r?\n/);
  const begin = lines.findIndex((l) => l.trim() === GITIGNORE_BEGIN);
  const end = lines.findIndex((l) => l.trim() === GITIGNORE_END);

  let before = '';
  let after = '';
  if (begin !== -1 && end !== -1 && end > begin) {
    before = lines.slice(0, begin).join('\n').replace(/\s+$/, '');
    after = lines.slice(end + 1).join('\n').replace(/^\s+/, '').replace(/\s+$/, '');
  } else {
    after = raw.replace(/^\s+|\s+$/g, '');
  }

  const merged = [before, block, after].filter((p) => p !== '').join('\n\n');
  return `${merged}\n`;
}

// ---------------------------------------------------------------------------
// 小物
// ---------------------------------------------------------------------------

function parseNodeMajor(version: string): number | null {
  const m = /^v?(\d+)\./.exec(version.trim());
  return m && m[1] !== undefined ? Number(m[1]) : null;
}

/** 2 スペースインデント + 末尾改行(プロジェクト内の既存 JSON 生成と統一)。 */
function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isNonEmptyDir(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

function listMarkdown(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

function detectPnp(projectRoot: string): boolean {
  return (
    fs.existsSync(path.join(projectRoot, '.pnp.cjs')) ||
    fs.existsSync(path.join(projectRoot, '.pnp.loader.mjs'))
  );
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

/**
 * `mnemo init` 本体。`cli/index.ts` の lazy dispatch から `run(ctx)` として呼ばれる。
 * テストは `run(ctx, deps)` で第 2 引数に注入する。
 *
 * 例外方針:
 * - step1(Node < 20)・step3(node_modules/mnemo 未インストール)・プロンプト拒否 → throw(exit 1)。
 * - buildIndex の失敗は throw しない(警告 + 続行)。
 */
export async function run(ctx: CliCommandContext, deps: InitDeps = {}): Promise<void> {
  const now = deps.now ?? ((): Date => new Date());
  const quiet = ctx.global.quiet;
  const asJson = ctx.global.json;
  const write = deps.out ?? ((chunk: string): void => void process.stdout.write(chunk));

  const warnings: string[] = [];
  const emit = (line: string): void => {
    if (!quiet && !asJson) {
      write(`${line}\n`);
    }
  };
  const emitWarn = (line: string): void => {
    warnings.push(line);
    if (!asJson) {
      write(`${ui.warn(`警告: ${line}`)}\n`);
    }
  };

  // --- step 1: Node バージョン ---------------------------------------
  const nodeVersion = deps.nodeVersion ?? process.version;
  const major = parseNodeMajor(nodeVersion);
  if (major !== null && major < 20) {
    throw new MnemoError(
      'NODE_VERSION_UNSUPPORTED',
      `Node.js 20 以上が必要です(現在 ${nodeVersion})。Node 20+ をインストールして再実行してください`,
      { nodeVersion },
    );
  }

  // --- step 2: projectRoot 決定 ------------------------------------------
  const baseCwd = deps.cwd ?? process.cwd();
  const rawDir = ctx.args[0];
  const projectRoot = resolveProjectRootForInit(
    rawDir !== undefined && rawDir !== ''
      ? path.isAbsolute(rawDir)
        ? rawDir
        : path.join(baseCwd, rawDir)
      : baseCwd,
  );
  const mnp = mnemothecaPaths(projectRoot);
  const prompts = deps.prompts ?? defaultPrompts;

  const existedBefore = fs.existsSync(projectRoot);
  if (!existedBefore) {
    fs.mkdirSync(projectRoot, { recursive: true });
  }
  const idempotent = fs.existsSync(mnp.configJson);

  // --- step 3: インストール検証 ----------------------------------------
  // `mnemo init` 自身は `package.json` を生成しないし `npm install` も実行しない
  // (ユーザーが `npm init -y && npm install github:<slug>#<tag>` を済ませている前提)。
  // ここでは `node_modules/mnemo/dist/{cli,mcp}/index.js` の両方が揃っているかだけ確認する。
  const nmMnemoDir = path.join(projectRoot, 'node_modules', 'mnemo');
  const cliEntry = path.join(nmMnemoDir, 'dist', 'cli', 'index.js');
  const mcpEntry = path.join(nmMnemoDir, 'dist', 'mcp', 'index.js');
  const installed = fs.existsSync(cliEntry) && fs.existsSync(mcpEntry);

  if (!installed) {
    throw new MnemoError(
      'NOT_INITIALIZED',
      'mnemo がインストールされていません。先に ' +
        `\`npm init -y && npm install github:${MNEMO_GITHUB_SLUG}#<tag>\` ` +
        'を実行してから再試行してください',
      { projectRoot },
    );
  }

  if (existedBefore && !idempotent && isNonEmptyDir(projectRoot)) {
    const ok = await prompts.confirmUseExistingDir(projectRoot);
    if (!ok) {
      throw new MnemoError('NOT_INITIALIZED', '初期化をキャンセルしました', { projectRoot });
    }
  }

  emit(ui.bold(`Mnemotheca を初期化します: ${projectRoot}`));
  if (idempotent) {
    emit(ui.dim('既に初期化済みです。vault/ の整合だけ確認して MCP スニペットを再表示します(冪等モード)'));
  }

  // --- step 4: .gitignore ---------------------------------------------
  // 管理ブロックだけを現行版へ収束させる(マーカー外のユーザー追記は不変)。
  // 内容に変化が無ければ書かない = git churn を出さない(config.json と同じ方針)。
  const gitignorePath = path.join(projectRoot, '.gitignore');
  const rawGitignore = fs.existsSync(gitignorePath)
    ? fs.readFileSync(gitignorePath, 'utf8')
    : '';
  const nextGitignore = mergeGitignore(rawGitignore);
  if (nextGitignore !== rawGitignore) {
    fs.writeFileSync(gitignorePath, nextGitignore, 'utf8');
    emit(ui.dim(rawGitignore === '' ? '.gitignore を生成しました' : '.gitignore を更新しました'));
  }

  // --- step 5: config.json + vault --------------------------------------
  fs.mkdirSync(mnp.dir, { recursive: true });
  if (!fs.existsSync(mnp.configJson)) {
    const iso = now().toISOString();
    fs.writeFileSync(mnp.configJson, serializeJson({ v: 1, createdAt: iso, updatedAt: iso }), 'utf8');
    emit(ui.dim('.mnemotheca/config.json を生成しました'));
  }
  // 冪等モードでは config.json を一切触らない(バイト列不変 = git churn 防止・設計 §8-B)。

  const vp = vaultPaths(projectRoot);
  fs.mkdirSync(vp.knowledgeDir, { recursive: true });
  fs.mkdirSync(vp.categoriesDir, { recursive: true });

  const existingNotes = listMarkdown(vp.knowledgeDir);
  if (existingNotes.length > 0) {
    const ok = await prompts.confirmUseExistingVault(existingNotes.length);
    if (!ok) {
      throw new MnemoError('NOT_INITIALIZED', '初期化をキャンセルしました(既存 vault)', {
        projectRoot,
        noteCount: existingNotes.length,
      });
    }
  }
  await writeVaultMarker(projectRoot);

  // --- step 6: 初回 buildIndex --------------------------------------
  try {
    await (deps.buildIndex ?? realBuildIndex)(projectRoot);
    await (deps.regenerateCategories ?? realRegenerateCategories)(projectRoot);
    emit(ui.dim('検索インデックスを構築しました'));
  } catch (err) {
    emitWarn(
      `初回インデックス構築に失敗しました(${err instanceof Error ? err.message : String(err)})。` +
        '後で `mnemo reindex` を実行してください',
    );
  }

  // --- step 7: 出力 --------------------------------------
  const snippet = (deps.buildMcpSnippet ?? realBuildMcpSnippet)(projectRoot, { client: 'desktop' });

  if (asJson) {
    write(
      `${JSON.stringify({
        projectRoot,
        serverKey: snippet.serverKey,
        snippetFilename: snippet.filename,
        snippet: snippet.snippet,
        idempotent,
        warnings,
      })}\n`,
    );
  } else {
    write('\n');
    write(`${ui.bold('MCP 連携スニペット')}(${snippet.filename} の "mcpServers" に追記してください。既存キーは消さない)\n`);
    write(`サーバーキー: ${snippet.serverKey}\n\n`);
    write(`${snippet.snippet}\n\n`);
    if (detectPnp(projectRoot)) {
      write(
        `${ui.warn(
          'PnP 環境ではスニペットの env.MNEMO_PROJECT が必須です(既定で含めています)',
        )}\n`,
      );
    }
    write(
      `${ui.info('次は `npx mnemo start`(または `node node_modules/mnemo/dist/cli/index.js start`)で UI を起動します')}\n`,
    );
    write(
      `${ui.info(
        'Claude にこう話しかけると保存されます: 「今の内容、Mnemotheca に保存して」',
      )}\n`,
    );
    if (warnings.length > 0) {
      write(`\n${ui.warn(`${warnings.length} 件の警告があります(上記)`)}\n`);
    }
  }
}
