// src/core/mcp-snippet.ts — MCP 連携スニペットの生成と陳腐化判定(設計書 §9-5 / §12-13 / §13-12a)。
//
// - `buildMcpSnippet(projectRoot, opts?)` … MCP クライアント(Claude Desktop / Claude Code)に
//   貼り付ける `mcpServers` スニペットを生成する。`command` は実行中 node の絶対パス
//   (`process.execPath`、N-2)、`args[0]` は projectRoot 内の MCP エントリ絶対パス、
//   `env.MNEMO_PROJECT` は projectRoot 絶対パス(常時同梱、N-1 / N-3)。サーバーキーは
//   `mnemotheca-<projectSlug>`(N-9。複数 projectRoot でのキー衝突を防ぐ)。
// - `projectSlug(projectRoot)` … サーバーキーの後半。basename 由来 + `projectHash` 先頭 6 桁。
// - `checkSnippetStale(claudeConfigs, projectRoot, deps?)` … 既存 Claude 設定と現在値を突き合わせ、
//   §9-5 の 8 条件を `SnippetCheck[]` で返す(`mnemo doctor` が使う。すべて warn / info・exit 0)。
//
// 依存は node:fs / node:path / node:child_process(と core/paths)のみ。外部通信は行わない(設計 §1-3)。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { projectHash } from './paths.js';

/** 実在するパスは `fs.realpathSync.native` で実体解決し、無ければ `path.resolve` にフォールバック。 */
function realOrResolve(p: string): string {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

// ---------------------------------------------------------------------------
// buildMcpSnippet / projectSlug
// ---------------------------------------------------------------------------

export interface McpSnippetOpts {
  /** 既定 `'desktop'`。出力 JSON 構造は同一で、貼り付け先ファイル名(`filename`)だけが変わる。 */
  client?: 'desktop' | 'code';
}

export interface McpSnippet {
  /** `mnemotheca-<projectSlug>`。`mnemo doctor` / 設定画面がユーザーに案内するキー名。 */
  serverKey: string;
  /** `JSON.stringify(obj, null, 2)`。`{ mcpServers: { [serverKey]: { command, args, env } } }`。 */
  snippet: string;
  /** 貼り付け先ファイル名。`client:'code'` → `.mcp.json` / 既定 → `claude_desktop_config.json`。 */
  filename: string;
}

/**
 * サーバーキー後半のスラッグを生成する(設計 §9-5)。
 *
 *   1. `path.basename(realpath(projectRoot))` を NFKC 正規化・小文字化
 *   2. `[a-z0-9]` 以外を `-` に置換 → 連続 `-` を 1 つに圧縮 → 先頭末尾 `-` を除去
 *   3. 空文字 or 先頭が数字なら `p` を前置
 *   4. 先頭 24 文字に切り詰め
 *   5. 常に `-` + `projectHash(projectRoot).slice(0, 6)` を後置
 *
 * 別 projectRoot が同名 basename でも、末尾の projectHash 6 桁で衝突しない。
 */
export function projectSlug(projectRoot: string): string {
  const base = path.basename(realOrResolve(projectRoot));

  let slug = base
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (slug === '' || /^[0-9]/.test(slug)) {
    slug = `p${slug}`;
  }

  // 24 文字に切り詰め、切り詰めで生じた末尾 `-` は除去する
  // (設計 §9-5 step 4。手順上は明記が無いが `slug--<hash>` を避けるための自明な整形)。
  slug = slug.slice(0, 24).replace(/-+$/g, '');

  return `${slug}-${projectHash(projectRoot).slice(0, 6)}`;
}

/**
 * MCP 連携スニペットを生成する(設計 §9-5)。
 *
 * 全絶対パスは `realpath(projectRoot)` 起点(symlink 経由で `mnemo` を叩いても同じキー・同じパス)。
 */
export function buildMcpSnippet(projectRoot: string, opts?: McpSnippetOpts): McpSnippet {
  const rp = realOrResolve(projectRoot);
  const serverKey = `mnemotheca-${projectSlug(projectRoot)}`;
  const mcpEntry = path.join(rp, 'node_modules', 'mnemo', 'dist', 'mcp', 'index.js');

  const obj = {
    mcpServers: {
      [serverKey]: {
        command: process.execPath, // 実行中 node の絶対パス(Windows は node.exe の絶対パス)。N-2
        args: [mcpEntry], // MCP エントリの絶対パス。パッケージ名 = 'mnemo'
        env: { MNEMO_PROJECT: rp }, // 常時同梱。N-1 / N-3
      },
    },
  };

  const snippet = JSON.stringify(obj, null, 2); // Windows のバックスラッシュ・スペース入りパスを自動エスケープ
  const filename = opts?.client === 'code' ? '.mcp.json' : 'claude_desktop_config.json';

  return { serverKey, snippet, filename };
}

// ---------------------------------------------------------------------------
// checkSnippetStale
// ---------------------------------------------------------------------------

/** 読めた Claude 設定ファイル 1 件分(`mnemo doctor` が渡す)。 */
export interface ClaudeConfig {
  /** どの設定ファイル由来か(案内用・任意)。 */
  path?: string;
  /** 設定ファイルの `mcpServers` オブジェクト。 */
  mcpServers?: Record<string, unknown> | undefined;
}

/** `checkSnippetStale` が返す 1 件の指摘(設計 §9-5 の 8 条件表)。 */
export interface SnippetCheck {
  /** §9-5 の条件番号(1..8)。 */
  id: number;
  /** すべて `'warn'`。ただし #8(未設定)のみ `'info'`。exit code は常に 0。 */
  severity: 'warn' | 'info';
  /** ユーザー向け案内文。 */
  message: string;
  /** 突き合わせた設定エントリのキー(#8 では省略)。 */
  key?: string;
  /** 由来した設定ファイル(分かれば)。 */
  configPath?: string;
}

/** `checkSnippetStale` の注入ポイント(テストで実プロセスを起動しないため)。 */
export interface SnippetCheckDeps {
  /**
   * `command` の node に `--version` を尋ねて出力(`'v20.11.0'` 形式)を返す。実行不能なら `null`。
   * 省略時は `spawnSync(command, ['--version'])`。
   */
  readNodeVersion?: (command: string) => string | null;
  /** `command` パスの実在判定。省略時は `fs.existsSync`。 */
  fileExists?: (p: string) => boolean;
}

/** 旧形式のサーバーキー(全 projectRoot で固定だったためキー衝突する)。 */
const LEGACY_SERVER_KEY = 'mnemotheca';

function defaultReadNodeVersion(command: string): string | null {
  try {
    const r = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 3000 });
    if (r.error || r.status !== 0 || typeof r.stdout !== 'string') {
      return null;
    }
    const out = r.stdout.trim();
    return out === '' ? null : out;
  } catch {
    return null;
  }
}

/** `'v20.11.0'` → `20`。パースできなければ `null`。 */
function parseNodeMajor(versionOutput: string): number | null {
  const m = /^v?(\d+)\./.exec(versionOutput.trim());
  return m && m[1] !== undefined ? Number(m[1]) : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 既知の Claude 設定群からこのプロジェクトの MCP エントリ(現形式 `mnemotheca-<projectSlug>` /
 * 旧形式 `"mnemotheca"`)を拾い、現在の正しい値と突き合わせる(設計 §9-5・全 8 条件)。
 *
 * 返り値が空配列なら陳腐化なし。1 件でもあれば `mnemo doctor` は `SNIPPET_STALE`(warn・exit 0)。
 * この関数は判定のみで、設定ファイルは一切書き換えない。
 */
export function checkSnippetStale(
  claudeConfigs: readonly ClaudeConfig[],
  projectRoot: string,
  deps: SnippetCheckDeps = {},
): SnippetCheck[] {
  const readNodeVersion = deps.readNodeVersion ?? defaultReadNodeVersion;
  const fileExists = deps.fileExists ?? ((p: string): boolean => fs.existsSync(p));

  const rp = realOrResolve(projectRoot);
  const serverKey = `mnemotheca-${projectSlug(projectRoot)}`;
  const expectedCommand = process.execPath;
  const expectedEntry = path.join(rp, 'node_modules', 'mnemo', 'dist', 'mcp', 'index.js');

  const checks: SnippetCheck[] = [];
  let matchedEntries = 0;

  for (const config of claudeConfigs) {
    const servers = config.mcpServers;
    if (!isRecord(servers)) {
      continue;
    }

    for (const key of [LEGACY_SERVER_KEY, serverKey]) {
      if (!Object.prototype.hasOwnProperty.call(servers, key)) {
        continue;
      }
      const entry = servers[key];
      if (!isRecord(entry)) {
        continue;
      }
      matchedEntries += 1;

      const push = (id: number, severity: 'warn' | 'info', message: string): void => {
        checks.push({ id, severity, message, key, configPath: config.path });
      };

      // #1: エントリのキーが旧形式 "mnemotheca"
      if (key === LEGACY_SERVER_KEY) {
        push(
          1,
          'warn',
          `複数プロジェクトでキーが衝突します。サーバーキーを "${serverKey}" へ変更してください(下記スニペット)`,
        );
      }

      // #2 / #3 / #4 / #7: command
      const command = typeof entry['command'] === 'string' ? entry['command'] : '';
      if (command === '' || !path.isAbsolute(command)) {
        push(
          2,
          'warn',
          '`command` を node の絶対パスにしてください。Claude Desktop はログインシェルの PATH を継承しません',
        );
      } else if (command !== expectedCommand) {
        push(
          3,
          'warn',
          'スニペットの node パスが現在の実行 node と異なります。node のバージョンを切り替えた場合は `mnemo init` でスニペットを再取得してください(意図的に別 node を使っているなら無視して構いません)',
        );
        if (!fileExists(command)) {
          push(
            4,
            'warn',
            'スニペットの node パスが実在しません。放置すると MCP クライアントが spawn ENOENT で起動失敗します。`mnemo init` で再取得してください',
          );
        } else {
          const versionOutput = readNodeVersion(command);
          const major = versionOutput === null ? null : parseNodeMajor(versionOutput);
          if (major !== null && major < 20) {
            push(7, 'warn', 'スニペットの node が v20 未満です。v20 以上の node 絶対パスに変えてください');
          }
        }
      }

      // #5: args[0]
      const args = Array.isArray(entry['args']) ? (entry['args'] as unknown[]) : [];
      const arg0 = args.length > 0 ? args[0] : undefined;
      if (typeof arg0 !== 'string' || arg0 !== expectedEntry) {
        push(
          5,
          'warn',
          'MCP エントリのパスが現在の projectRoot と一致しません(プロジェクトを移動 / 改名しましたか?)',
        );
      }

      // #6: env.MNEMO_PROJECT
      const env = isRecord(entry['env']) ? entry['env'] : undefined;
      const mnemoProject = env?.['MNEMO_PROJECT'];
      if (typeof mnemoProject !== 'string' || realOrResolve(mnemoProject) !== rp) {
        push(
          6,
          'warn',
          '`env.MNEMO_PROJECT` を現在の projectRoot 絶対パスにしてください(yarn PnP / symlink 対策)',
        );
      }
    }
  }

  // #8: どの設定ファイルからも当該キーのエントリが見つからなかった
  if (matchedEntries === 0) {
    checks.push({
      id: 8,
      severity: 'info',
      message:
        'MCP 連携が未設定の可能性があります。下記スニペットを Claude 設定ファイルの `mcpServers` に追記してください(既存キーは消さない)',
    });
  }

  return checks;
}
