#!/usr/bin/env node
// src/cli/index.ts — mnemo CLI エントリ(`dist/cli/index.js` として package.json の bin に登録)。
//
// 設計書 §9-1 / §12-1(CLI 面)。責務:
//   - commander の program 定義(グローバルオプション + 全サブコマンド登録)
//   - projectRoot の解決(`--project` / `MNEMO_PROJECT` env / cwd からの親探索)
//   - `MnemoError` → stderr 赤字 + 「次のコマンドで解決できます: …」+ exit 1
//   - `--json` で機械可読出力
//
// サブコマンドの実体は `cli/commands/*.ts` に置く。
// ここでは **遅延 import**(`await import('./commands/<name>.js')`)で登録し、実体が
// 無くても `--version` / `--help` / エラー処理は動くようにしている。commands/* は
// 静的 import しない。

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Command, CommanderError } from 'commander';
import { isMnemoError } from '../core/errors.js';
import { resolveProjectRoot } from '../core/paths.js';
import * as ui from './ui.js';

/** 登録するサブコマンド名(設計書 §9-1。`config` は廃止)。 */
export const SUBCOMMANDS = [
  'init',
  'start',
  'stop',
  'status',
  'reindex',
  'mcp',
  'doctor',
  'open',
] as const;

export type SubcommandName = (typeof SUBCOMMANDS)[number];

/**
 * projectRoot の事前解決が必要なサブコマンド。
 * `init`(まだ存在しない projectRoot を作る)・`mcp`(自前で解決)・`doctor`
 * (未初期化でも診断を続けたいので寛容に扱う)は対象外。
 */
const NEEDS_PROJECT: ReadonlySet<SubcommandName> = new Set(['start', 'stop', 'status', 'reindex', 'open']);

/** 正規化済みのグローバルオプション。 */
export interface CliGlobalOptions {
  /** `--project <path>`。未指定なら undefined。 */
  project: string | undefined;
  /** `--json`。 */
  json: boolean;
  /** `--quiet`。 */
  quiet: boolean;
}

/** サブコマンド実体(`commands/<name>.ts` の `run`)へ渡す実行コンテキスト。 */
export interface CliCommandContext {
  /** サブコマンド名。 */
  name: SubcommandName;
  /** 位置引数(例: `init [dir]` の `dir`)。 */
  args: string[];
  /** サブコマンド固有オプション。 */
  options: Record<string, unknown>;
  /** グローバルオプション(正規化済み)。 */
  global: CliGlobalOptions;
  /**
   * 解決済み projectRoot。`NEEDS_PROJECT` のコマンドでのみセットされる。
   * それ以外は undefined(コマンド側が必要に応じて自前で解決する)。
   */
  projectRoot: string | undefined;
}

/** サブコマンド実体へのディスパッチ関数(テストで差し替え可能)。 */
export type Dispatch = (name: SubcommandName, ctx: CliCommandContext) => Promise<void> | void;

export interface RunOptions {
  /** projectRoot の親探索の起点。省略時 `process.cwd()`。 */
  cwd?: string;
  /** サブコマンド実体へのディスパッチ。省略時は `commands/<name>.js` を遅延 import。 */
  dispatch?: Dispatch;
}

function normalizeGlobals(raw: Record<string, unknown>): CliGlobalOptions {
  return {
    project: typeof raw['project'] === 'string' ? raw['project'] : undefined,
    json: raw['json'] === true,
    quiet: raw['quiet'] === true,
  };
}

/** バージョン文字列を package.json から読む(dist / src どちらの配置でもリポジトリ直下)。 */
function readVersion(): string {
  try {
    const raw = fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function isModuleNotFound(err: unknown, name: string): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ERR_MODULE_NOT_FOUND') {
    return true;
  }
  if (err instanceof Error) {
    return new RegExp(`commands[\\\\/]${name}(\\.js)?`).test(err.message);
  }
  return false;
}

/**
 * 既定のディスパッチ: `./commands/<name>.js` を遅延 import して `run(ctx)` を呼ぶ。
 * 実体がまだ無いサブコマンドは「未実装」の弱調メッセージを出して正常終了する
 * (実体が入れば自動的にそちらが動く)。
 */
const lazyDispatch: Dispatch = async (name, ctx) => {
  let mod: { run?: (c: CliCommandContext) => unknown };
  // 具体名を実行時に組み立てる(バンドラの static analysis を避け、実体が無くても
  // ここまでは到達できるようにする)。commands/* は静的 import しない。
  const specifier = './commands/'.concat(name, '.js');
  try {
    mod = (await import(specifier)) as { run?: (c: CliCommandContext) => unknown };
  } catch (err) {
    if (isModuleNotFound(err, name)) {
      if (!ctx.global.quiet && !ctx.global.json) {
        process.stdout.write(`${ui.dim(`(${name} コマンドは未実装です)`)}\n`);
      }
      return;
    }
    throw err;
  }
  if (typeof mod.run !== 'function') {
    throw new Error(`commands/${name}.js が run() を export していません`);
  }
  await mod.run(ctx);
};

/**
 * commander の program を組み立てる。`run()` から使われるが、テストが
 * `createProgram()` を直接叩けるよう export しておく。
 */
export function createProgram(opts: RunOptions = {}): Command {
  const cwd = opts.cwd ?? process.cwd();
  const dispatch = opts.dispatch ?? lazyDispatch;

  // preAction フックで解決した projectRoot を action へ橋渡しする(パースは逐次実行)。
  const state: { projectRoot: string | undefined } = { projectRoot: undefined };

  const program = new Command();
  program
    .name('mnemo')
    .description('Mnemo — AI チャットから育てるローカル Markdown セカンドブレイン')
    .version(readVersion())
    .option('--project <path>', 'projectRoot を明示する(省略時は cwd から親探索。MNEMO_PROJECT env でも可)')
    .option('--json', '機械可読な JSON を stdout に出力する')
    .option('--quiet', '進捗・補助メッセージを抑制する');

  program.hook('preAction', (thisCommand, actionCommand) => {
    const name = actionCommand.name() as SubcommandName;
    state.projectRoot = undefined;
    if (NEEDS_PROJECT.has(name)) {
      const g = normalizeGlobals(thisCommand.opts());
      // resolveProjectRoot: projectFlag ?? MNEMO_PROJECT を優先し、無ければ startDir から親探索(設計 §8-A)。
      state.projectRoot = resolveProjectRoot({ startDir: cwd, projectFlag: g.project });
    }
  });

  const register = (
    name: SubcommandName,
    configure: (c: Command) => void,
  ): void => {
    const c = program.command(name);
    configure(c);
    c.action(async (...actionArgs: unknown[]) => {
      const actionCommand = actionArgs[actionArgs.length - 1] as Command;
      const ctx: CliCommandContext = {
        name,
        args: actionCommand.args.slice(),
        options: actionCommand.opts(),
        global: normalizeGlobals(actionCommand.optsWithGlobals()),
        projectRoot: state.projectRoot,
      };
      await dispatch(name, ctx);
    });
  };

  register('init', (c) => {
    c.description('projectRoot を初期化する(§9-4 ブートストラップ)')
      .argument('[dir]', '初期化先ディレクトリ(省略時は cwd)');
  });
  register('start', (c) => {
    c.description('HTTP サーバーをフォアグラウンド起動する')
      .option('--port <n>', 'ポート番号を指定する')
      .option('--no-open', 'ブラウザを自動で開かない');
  });
  register('stop', (c) => {
    c.description('稼働中の HTTP サーバーを停止する');
  });
  register('status', (c) => {
    c.description('サーバー稼働状態・projectRoot・インデックス鮮度などを表示する');
  });
  register('reindex', (c) => {
    c.description('検索インデックスを再構築する')
      .option('--full', 'キャッシュを削除して全再構築する')
      .option('--no-categories', 'カテゴリ一覧の再生成をスキップする');
  });
  register('mcp', (c) => {
    c.description('stdio MCP サーバーを起動する(MCP クライアント設定用。人間は直接使わない)');
  });
  register('doctor', (c) => {
    c.description('プロジェクトを診断する')
      .option('--fix', '自動修復可能な問題を修復する');
  });
  register('open', (c) => {
    c.description('稼働中サーバーの URL をブラウザで開く');
  });

  return program;
}

/**
 * CLI 本体。`argv` は `process.argv.slice(2)` 相当(プログラム名を含まない)。
 * 戻り値は exit code(呼び出し側が `process.exit` する)。例外は投げない。
 */
export async function run(argv: string[], opts: RunOptions = {}): Promise<number> {
  const program = createProgram(opts);
  program.exitOverride();
  for (const c of program.commands) {
    c.exitOverride();
  }

  try {
    await program.parseAsync(argv, { from: 'user' });
    return 0;
  } catch (err) {
    return handleTopLevelError(err, program);
  }
}

function handleTopLevelError(err: unknown, program: Command): number {
  // commander 由来(--help / --version / 使い方エラー): commander が既に出力済み。exit code だけ返す。
  if (err instanceof CommanderError) {
    return typeof err.exitCode === 'number' ? err.exitCode : 1;
  }

  const g = normalizeGlobals(program.opts());

  if (isMnemoError(err)) {
    if (g.json) {
      process.stdout.write(`${JSON.stringify(ui.errorToJson(err))}\n`);
    } else {
      process.stderr.write(`${ui.renderMnemoError(err)}\n`);
    }
    return 1;
  }

  // 想定外エラー。
  const message = err instanceof Error ? err.message : String(err);
  if (g.json) {
    process.stdout.write(`${JSON.stringify({ error: { code: 'UNEXPECTED', message } })}\n`);
  } else {
    process.stderr.write(`${ui.error(message)}\n`);
  }
  return 1;
}

// `node dist/cli/index.js …` として直接起動されたときだけ実行する
// (テストから import される場合は何もしない)。
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  void run(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
