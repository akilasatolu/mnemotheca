// src/cli/commands/doctor.ts — `mnemo doctor [--fix]`(設計書 §9-1 doctor 行 / §9-5 / §12-10 / §13-14)。
//
// プロジェクトの健全性を総点検し、非破壊な自動修復(`--fix`)を行う。「`mnemo` を
// `node_modules/mnemo` に npm 依存としてインストールして使う」方式特有のチェック
// (`DIST_MISSING` / MCP スニペット陳腐化)を含む。
//
// 検出項目:
//   - config 健全性(`loadConfig`)
//   - vault 到達性 + vault マーカー(`checkVault`)
//   - 本体のインストール状況(`DIST_MISSING`: `node_modules/mnemo` の存在)
//   - ランタイムディレクトリの書き込み可否 + モード(`0700`)
//   - インデックス health(`meta.json`)
//   - usage_log 末尾破損
//   - パースエラーノート一覧(`parse-errors.json`)
//   - conflict copy 一覧(`conflicts.json`)
//   - stale ロック
//   - Node バージョン
//   - MCP 連携スニペットの陳腐化(`checkSnippetStale` の 8 条件)+ 現在値スニペット表示
//   - yarn PnP レイアウト
//   - 中断した organize(`organize-session.json` の `applying:true` → **報告のみ**)
//
// `--fix` で修復するもの: vault マーカー再生成 / usage_log 末尾破損修復 / stale ロック削除 /
//   vault サブディレクトリ再作成 / ランタイムディレクトリ `chmod 0700`。
// **中断 organize / Claude 設定ファイル / `npm install` は `--fix` でも自動実行しない。**
//
// 外部 I/O(fs / ネットワーク / 子プロセス / Claude 設定探索)はすべて `DoctorDeps` で
// 注入でき、テストは実ネットワーク・実 Claude 設定に一切触れない。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig as realLoadConfig, writeVaultMarker as realWriteVaultMarker } from '../../core/config.js';
import { MnemoError, isMnemoError, type ErrorCode } from '../../core/errors.js';
import {
  buildMcpSnippet as realBuildMcpSnippet,
  checkSnippetStale as realCheckSnippetStale,
  type ClaudeConfig,
  type McpSnippet,
  type SnippetCheck,
  type SnippetCheckDeps,
} from '../../core/mcp-snippet.js';
import {
  findConfigAnchor,
  mnemothecaPaths,
  runtimePaths,
  vaultPaths,
} from '../../core/paths.js';
import { repairUsageTail as realRepairUsageTail } from '../../core/usage-log.js';
import { checkVault as realCheckVault, type VaultCheckResult } from '../../core/vault-check.js';
import type { CliCommandContext } from '../index.js';
import * as ui from '../ui.js';

// ---------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------

/** 1 件の診断結果。 */
export interface DoctorCheck {
  /** 内部 ID(`--json` の識別用)。 */
  id: string;
  /** `error` は未修復のまま残ると exit 1。`warn` / `info` は exit 0。 */
  severity: 'error' | 'warn' | 'info';
  /** ユーザー向け案内文。 */
  message: string;
  /** error のとき、対応する `ErrorCode`(exit 時に投げる `MnemoError` に使う)。 */
  code?: ErrorCode;
  /** `--fix` で自動修復可能か。 */
  fixable: boolean;
  /** `--fix` を実行し修復できたか(未実行なら undefined)。 */
  fixed?: boolean;
  /** `--fix` の失敗理由。 */
  fixError?: string;
  /** 関連パス(パースエラー / conflict / stale ロックの一覧など)。 */
  paths?: string[];
}

/** `mnemo doctor` 全体の構造化レポート(`--json`)。 */
export interface DoctorReport {
  ok: boolean;
  fix: boolean;
  projectRoot: string;
  checks: DoctorCheck[];
  /** 本体(`node_modules/mnemo`)のインストール有無。 */
  dist: {
    present: boolean;
  };
  snippetStale: {
    checks: SnippetCheck[];
    currentSnippet: string;
    serverKey: string;
  } | null;
  organizeInterrupted: { snapshotId: string; since: string | null } | null;
}

/** `mnemo doctor` の注入ポイント。省略時は本物(テストは必ず差し替える)。 */
export interface DoctorDeps {
  /** projectRoot 探索の起点。省略時 `process.cwd()`。 */
  cwd?: string;
  /** Node バージョン文字列。省略時 `process.version`。 */
  nodeVersion?: string;
  /** projectRoot を解決する(見つからなければ null)。省略時 `findConfigAnchor`。 */
  resolveProjectRoot?: (startDir: string) => string | null;
  /** `.mnemotheca/config.json` の健全性チェック。省略時 `core/config.loadConfig`。 */
  loadConfig?: (projectRoot: string) => Promise<unknown>;
  /** vault 健全性チェック。省略時 `core/vault-check.checkVault`。 */
  checkVault?: (projectRoot: string) => Promise<VaultCheckResult>;
  /** vault マーカー再生成。省略時 `core/config.writeVaultMarker`。 */
  writeVaultMarker?: (projectRoot: string) => Promise<void>;
  /** usage_log 末尾破損修復。省略時 `core/usage-log.repairUsageTail`。 */
  repairUsageTail?: (projectRoot: string) => Promise<{ trimmed: boolean }>;
  /** usage_log の末尾が壊れているか(非破壊の検出)。省略時はファイルを読んで判定。 */
  detectUsageTailBroken?: (projectRoot: string) => Promise<boolean>;
  /** 既知の場所から読めた Claude 設定を返す。省略時は OS 標準パスを探索。 */
  discoverClaudeConfigs?: (projectRoot: string) => ClaudeConfig[];
  /** `checkSnippetStale`。省略時 `core/mcp-snippet.checkSnippetStale`。 */
  checkSnippetStale?: (
    configs: readonly ClaudeConfig[],
    projectRoot: string,
    deps?: SnippetCheckDeps,
  ) => SnippetCheck[];
  /** `checkSnippetStale` に渡す注入(node バージョン確認・実在判定)。 */
  snippetCheckDeps?: SnippetCheckDeps;
  /** MCP スニペット生成。省略時 `core/mcp-snippet.buildMcpSnippet`。 */
  buildMcpSnippet?: (projectRoot: string, opts?: { client?: 'desktop' | 'code' }) => McpSnippet;
  /** stale ロックと判定する無応答時間(ms)。省略時 5 分。 */
  staleLockMs?: number;
  /** 現在時刻。省略時 `() => Date.now()`。 */
  nowMs?: () => number;
  /** 1 行出力(既定 stdout)。 */
  out?: (line: string) => void;
}

// ---------------------------------------------------------------------------
// 既定実装
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function readJsonSync(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await fs.promises.readFile(file, 'utf8')) as unknown;
}

/** OS 標準の Claude 設定探索パス(設計 §9-5)。読めた object だけを返す。 */
function defaultDiscoverClaudeConfigs(projectRoot: string): ClaudeConfig[] {
  const home = os.homedir();
  const platform = process.platform;
  const candidates: string[] = [];
  if (platform === 'darwin') {
    candidates.push(
      path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    );
  } else if (platform === 'win32') {
    const appdata = process.env['APPDATA'];
    if (appdata !== undefined && appdata !== '') {
      candidates.push(path.join(appdata, 'Claude', 'claude_desktop_config.json'));
    }
  } else {
    candidates.push(path.join(home, '.config', 'Claude', 'claude_desktop_config.json'));
  }
  candidates.push(path.join(home, '.claude.json'));
  candidates.push(path.join(projectRoot, '.mcp.json'));

  const out: ClaudeConfig[] = [];
  const seen = new Set<string>();
  for (const file of candidates) {
    if (seen.has(file)) continue;
    seen.add(file);
    let parsed: unknown;
    try {
      parsed = readJsonSync(file);
    } catch {
      continue; // 読めない / JSON 破損 → 無視(設計「読めたものだけ」)
    }
    if (!isRecord(parsed)) continue;
    const mcpServers = isRecord(parsed['mcpServers']) ? parsed['mcpServers'] : undefined;
    out.push({ path: file, mcpServers });
  }
  return out;
}

async function defaultDetectUsageTailBroken(projectRoot: string): Promise<boolean> {
  const { usageLogJsonl } = mnemothecaPaths(projectRoot);
  let raw: string;
  try {
    raw = await fs.promises.readFile(usageLogJsonl, 'utf8');
  } catch {
    return false;
  }
  return raw !== '' && !raw.endsWith('\n');
}

function resolveDeps(over?: Partial<DoctorDeps>): Required<
  Pick<
    DoctorDeps,
    | 'cwd'
    | 'nodeVersion'
    | 'resolveProjectRoot'
    | 'loadConfig'
    | 'checkVault'
    | 'writeVaultMarker'
    | 'repairUsageTail'
    | 'detectUsageTailBroken'
    | 'discoverClaudeConfigs'
    | 'checkSnippetStale'
    | 'buildMcpSnippet'
    | 'staleLockMs'
    | 'nowMs'
    | 'out'
  >
> & {
  snippetCheckDeps: SnippetCheckDeps;
} {
  return {
    cwd: over?.cwd ?? process.cwd(),
    nodeVersion: over?.nodeVersion ?? process.version,
    resolveProjectRoot: over?.resolveProjectRoot ?? ((startDir: string): string | null => findConfigAnchor(startDir)),
    loadConfig: over?.loadConfig ?? realLoadConfig,
    checkVault: over?.checkVault ?? realCheckVault,
    writeVaultMarker: over?.writeVaultMarker ?? realWriteVaultMarker,
    repairUsageTail: over?.repairUsageTail ?? realRepairUsageTail,
    detectUsageTailBroken: over?.detectUsageTailBroken ?? defaultDetectUsageTailBroken,
    discoverClaudeConfigs: over?.discoverClaudeConfigs ?? defaultDiscoverClaudeConfigs,
    checkSnippetStale: over?.checkSnippetStale ?? realCheckSnippetStale,
    snippetCheckDeps: over?.snippetCheckDeps ?? {},
    buildMcpSnippet: over?.buildMcpSnippet ?? realBuildMcpSnippet,
    staleLockMs: over?.staleLockMs ?? 5 * 60_000,
    nowMs: over?.nowMs ?? ((): number => Date.now()),
    out: over?.out ?? ((line: string): void => void process.stdout.write(`${line}\n`)),
  };
}

// ---------------------------------------------------------------------------
// 個別チェック
// ---------------------------------------------------------------------------

function parseNodeMajor(version: string): number | null {
  const m = /^v?(\d+)\./.exec(version.trim());
  return m && m[1] !== undefined ? Number(m[1]) : null;
}

/** 本体(`node_modules/mnemo`)がインストールされているか。 */
function distPresent(projectRoot: string): boolean {
  return fs.existsSync(path.join(projectRoot, 'node_modules', 'mnemo'));
}

/** proper-lockfile が作る `<scope>.lock` ディレクトリのうち mtime が古いものを列挙。 */
async function findStaleLocks(
  projectRoot: string,
  staleMs: number,
  nowMs: number,
): Promise<string[]> {
  let locksDir: string;
  try {
    locksDir = runtimePaths(projectRoot).locksDir;
  } catch {
    return [];
  }
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(locksDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const stale: string[] = [];
  for (const ent of entries) {
    if (!ent.name.endsWith('.lock')) continue;
    const full = path.join(locksDir, ent.name);
    try {
      const st = await fs.promises.stat(full);
      if (nowMs - st.mtimeMs > staleMs) {
        stale.push(full);
      }
    } catch {
      /* 消えていたら無視 */
    }
  }
  return stale;
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

export async function run(ctx: CliCommandContext, over?: Partial<DoctorDeps>): Promise<void> {
  const deps = resolveDeps(over);
  const fix = ctx.options['fix'] === true;
  const json = ctx.global.json;
  const quiet = ctx.global.quiet;

  // --- projectRoot 解決(寛容: 未初期化でも診断を試みる) -------------------
  const projectRoot = ctx.projectRoot ?? deps.resolveProjectRoot(deps.cwd);
  if (projectRoot === undefined || projectRoot === null) {
    throw new MnemoError(
      'NOT_INITIALIZED',
      'このディレクトリ配下に Mnemotheca プロジェクトが見つかりません。`mnemo init` で初期化してください',
    );
  }

  const mnp = mnemothecaPaths(projectRoot);
  const checks: DoctorCheck[] = [];
  const add = (c: DoctorCheck): void => void checks.push(c);

  // --- Node バージョン --------------------------------------------------
  const major = parseNodeMajor(deps.nodeVersion);
  if (major !== null && major < 20) {
    add({
      id: 'NODE_VERSION',
      severity: 'warn',
      message: `Node.js が v20 未満です(現在 ${deps.nodeVersion})。v20 以上へ更新してください`,
      fixable: false,
    });
  }

  // --- config 健全性 --------------------------------------------------
  try {
    await deps.loadConfig(projectRoot);
  } catch (err) {
    if (isMnemoError(err) && err.code === 'CONFIG_CORRUPT') {
      add({
        id: 'CONFIG_CORRUPT',
        severity: 'error',
        code: 'CONFIG_CORRUPT',
        message: err.message,
        fixable: false,
      });
    } else if (isMnemoError(err) && err.code === 'NOT_INITIALIZED') {
      add({
        id: 'CONFIG_MISSING',
        severity: 'error',
        code: 'NOT_INITIALIZED',
        message: '`.mnemotheca/config.json` がありません。`mnemo init` で初期化してください',
        fixable: false,
      });
    } else {
      add({
        id: 'CONFIG_UNREADABLE',
        severity: 'error',
        code: 'CONFIG_CORRUPT',
        message: `config.json を読めませんでした: ${err instanceof Error ? err.message : String(err)}`,
        fixable: false,
      });
    }
  }

  // --- vault 到達性 + マーカー -----------------------------------------
  const vault = await deps.checkVault(projectRoot);
  if (!vault.ok) {
    if (vault.reason === 'vault-missing') {
      add({
        id: 'VAULT_MISSING',
        severity: 'error',
        code: 'VAULT_UNAVAILABLE',
        message: '`vault/` が見つかりません。`--fix` で `vault/knowledge/` `vault/categories/` を作り直します',
        fixable: true,
      });
    } else if (vault.reason === 'vault-not-dir') {
      add({
        id: 'VAULT_NOT_DIR',
        severity: 'error',
        code: 'VAULT_UNAVAILABLE',
        message: '`vault/` がディレクトリではありません。手動で確認してください',
        fixable: false,
      });
    } else {
      add({
        id: 'VAULT_NOT_WRITABLE',
        severity: 'error',
        code: 'VAULT_NOT_WRITABLE',
        message: '`vault/` に書き込めません。権限を確認してください',
        fixable: false,
      });
    }
  } else if (vault.reason === 'marker-missing') {
    add({
      id: 'VAULT_MARKER_MISSING',
      severity: 'warn',
      message:
        'vault マーカー(`vault/.mnemotheca-vault.json`)がありません。`vault/` にナレッジがあるなら `--fix` で再生成します',
      fixable: true,
    });
  }

  // vault/ 本体は存在するが必須サブディレクトリ(`vault/knowledge/` `vault/categories/`)
  // だけが欠落したケース。`checkVault` は 4 reason しか返さず `vault.ok === true` で
  // 通過するため、doctor 側で個別に検出する(設計 §4-1 / §9-1 `--fix` 対象)。
  if (vault.ok) {
    const vp = vaultPaths(projectRoot);
    const missingSubdirs = ([
      ['knowledge', vp.knowledgeDir],
      ['categories', vp.categoriesDir],
    ] as const)
      .filter(([, dir]) => {
        try {
          return !fs.statSync(dir).isDirectory();
        } catch {
          return true;
        }
      })
      .map(([, dir]) => dir);
    if (missingSubdirs.length > 0) {
      add({
        id: 'VAULT_SUBDIR_MISSING',
        severity: 'warn',
        message:
          '`vault/` の必須サブディレクトリが欠落しています。`--fix` で再作成します',
        fixable: true,
        paths: missingSubdirs,
      });
    }
  }

  // --- 本体(node_modules/mnemo)のインストール状況 -----------------------
  const distOk = distPresent(projectRoot);
  if (!distOk) {
    add({
      id: 'DIST_MISSING',
      severity: 'error',
      code: 'NODE_MODULES_MISSING',
      message: '本体(`node_modules/mnemo`)が見つかりません。`npm install` を実行してください',
      fixable: false,
    });
  }

  // --- ランタイムディレクトリ 書き込み可否 + モード -----------------------
  let runtimeDir: string | null = null;
  try {
    runtimeDir = runtimePaths(projectRoot).dir;
  } catch (err) {
    if (isMnemoError(err) && err.code === 'RUNTIME_DIR_UNWRITABLE') {
      add({
        id: 'RUNTIME_DIR_UNWRITABLE',
        severity: 'error',
        code: 'RUNTIME_DIR_UNWRITABLE',
        message: err.message,
        fixable: false,
      });
    } else {
      throw err;
    }
  }
  if (runtimeDir !== null && process.platform !== 'win32') {
    try {
      const st = await fs.promises.stat(runtimeDir);
      if ((st.mode & 0o077) !== 0) {
        add({
          id: 'RUNTIME_DIR_MODE',
          severity: 'warn',
          message: `一時ディレクトリ \`${runtimeDir}\` のモードが 0700 ではありません。\`--fix\` で修正します`,
          fixable: true,
        });
      }
    } catch {
      /* まだ作られていない(必要時に 0700 で作られる)→ 問題なし */
    }
  }

  // --- インデックス health(meta.json) --------------------------------
  try {
    const meta = await readJson(mnp.metaJson);
    if (!isRecord(meta)) {
      add({
        id: 'INDEX_META_CORRUPT',
        severity: 'warn',
        message: '`meta.json` が壊れています。`mnemo reindex --full` で再構築してください',
        fixable: false,
      });
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      add({
        id: 'INDEX_MISSING',
        severity: 'info',
        message: '検索インデックスが未構築です。`mnemo reindex` を実行してください',
        fixable: false,
      });
    } else {
      add({
        id: 'INDEX_META_CORRUPT',
        severity: 'warn',
        message: '`meta.json` を読めませんでした。`mnemo reindex --full` で再構築してください',
        fixable: false,
      });
    }
  }

  // --- usage_log 末尾破損 --------------------------------------------
  if (await deps.detectUsageTailBroken(projectRoot)) {
    add({
      id: 'USAGE_LOG_TAIL',
      severity: 'warn',
      message: 'usage_log の末尾に書きかけの行があります。`--fix` で切り詰めます',
      fixable: true,
    });
  }

  // --- パースエラーノート一覧(parse-errors.json) ---------------------
  try {
    const pe = await readJson(mnp.parseErrorsJson);
    if (Array.isArray(pe) && pe.length > 0) {
      const paths = pe
        .map((e) => (isRecord(e) && typeof e['path'] === 'string' ? e['path'] : null))
        .filter((p): p is string => p !== null);
      add({
        id: 'PARSE_ERRORS',
        severity: 'warn',
        message: `${pe.length} 件のノートにパースエラーがあります。frontmatter を修正して \`mnemo reindex\` してください`,
        fixable: false,
        paths,
      });
    }
  } catch {
    /* 無い / 破損 → スキップ */
  }

  // --- conflict copy 一覧(conflicts.json。§10-6 スキーマ) ------------
  try {
    const cf = await readJson(mnp.conflictsJson);
    if (Array.isArray(cf) && cf.length > 0) {
      const paths = cf
        .map((e) => (isRecord(e) && typeof e['path'] === 'string' ? e['path'] : null))
        .filter((p): p is string => p !== null);
      add({
        id: 'CONFLICTS',
        severity: 'warn',
        message: `${cf.length} 件の conflict copy があります。内容を確認して手動で統合 / 削除してください`,
        fixable: false,
        paths,
      });
    }
  } catch {
    /* 無い / 破損 → スキップ */
  }

  // --- stale ロック --------------------------------------------------
  const staleLocks = await findStaleLocks(projectRoot, deps.staleLockMs, deps.nowMs());
  if (staleLocks.length > 0) {
    add({
      id: 'STALE_LOCK',
      severity: 'warn',
      message: `${staleLocks.length} 件の古いロックが残っています。\`--fix\` で削除します`,
      fixable: true,
      paths: staleLocks,
    });
  }

  // --- yarn PnP レイアウト ------------------------------------------
  if (
    fs.existsSync(path.join(projectRoot, '.pnp.cjs')) ||
    fs.existsSync(path.join(projectRoot, '.pnp.loader.mjs'))
  ) {
    add({
      id: 'PNP_LAYOUT',
      severity: 'warn',
      message:
        'yarn PnP レイアウトを検出しました。MCP スニペットの `env.MNEMO_PROJECT`(既定で同梱)が必須です',
      fixable: false,
    });
  }

  // --- 中断した organize(報告のみ・--fix でも触らない) ------------------
  let organizeInterrupted: { snapshotId: string; since: string | null } | null = null;
  try {
    const session = await readJson(mnp.organizeSessionJson);
    if (isRecord(session) && session['applying'] === true) {
      const snapshotId =
        typeof session['snapshotId'] === 'string' ? session['snapshotId'] : '(不明)';
      const since = typeof session['scannedAt'] === 'string' ? session['scannedAt'] : null;
      organizeInterrupted = { snapshotId, since };
      add({
        id: 'ORGANIZE_INTERRUPTED',
        severity: 'warn',
        message:
          `organize が中断されたままです(snapshot \`${snapshotId}\`${since !== null ? `, ${since}` : ''})。` +
          '取り消して元に戻すには AI に『前回の整理を取り消して』と伝えてください' +
          '(内部的に `mnemo_organize_undo` が実行されます)。' +
          '中断状態のまま進めたい場合は次の organize 時に AI がスキップします',
        fixable: false,
      });
    }
  } catch {
    /* 無い / 破損 → スキップ */
  }

  // --- MCP スニペット陳腐化(SNIPPET_STALE) ---------------------------
  const claudeConfigs = deps.discoverClaudeConfigs(projectRoot);
  const snippetChecks = deps.checkSnippetStale(claudeConfigs, projectRoot, deps.snippetCheckDeps);
  const currentSnippet = deps.buildMcpSnippet(projectRoot, { client: 'desktop' });
  const snippetStaleJson = {
    checks: snippetChecks,
    currentSnippet: currentSnippet.snippet,
    serverKey: currentSnippet.serverKey,
  };
  for (const sc of snippetChecks) {
    add({
      id: `SNIPPET_STALE#${sc.id}`,
      severity: sc.severity,
      message: sc.message,
      fixable: false,
    });
  }

  // --- `--fix` の適用 ------------------------------------------------
  if (fix) {
    for (const c of checks) {
      if (!c.fixable) continue;
      try {
        await applyFix(c, projectRoot, deps, runtimeDir);
        c.fixed = true;
      } catch (err) {
        c.fixed = false;
        c.fixError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  // --- 判定 + 出力 --------------------------------------------------
  const ok = !checks.some((c) => c.severity === 'error' && c.fixed !== true);

  const report: DoctorReport = {
    ok,
    fix,
    projectRoot,
    checks,
    dist: { present: distOk },
    snippetStale: snippetStaleJson,
    organizeInterrupted,
  };

  if (json) {
    deps.out(JSON.stringify(report));
  } else if (!quiet) {
    renderHuman(report, deps.out);
  }

  if (!ok) {
    const firstError = checks.find((c) => c.severity === 'error' && c.fixed !== true);
    const code: ErrorCode = firstError?.code ?? 'CONFIG_CORRUPT';
    throw new MnemoError(code, 'mnemo doctor: 未解決の問題があります(上記を参照)');
  }
}

// ---------------------------------------------------------------------------
// --fix 実装
// ---------------------------------------------------------------------------

async function applyFix(
  c: DoctorCheck,
  projectRoot: string,
  deps: ReturnType<typeof resolveDeps>,
  runtimeDir: string | null,
): Promise<void> {
  switch (c.id) {
    case 'VAULT_MISSING': {
      const vp = vaultPaths(projectRoot);
      await fs.promises.mkdir(vp.knowledgeDir, { recursive: true });
      await fs.promises.mkdir(vp.categoriesDir, { recursive: true });
      await deps.writeVaultMarker(projectRoot);
      return;
    }
    case 'VAULT_SUBDIR_MISSING': {
      for (const p of c.paths ?? []) {
        await fs.promises.mkdir(p, { recursive: true });
      }
      return;
    }
    case 'VAULT_MARKER_MISSING': {
      await deps.writeVaultMarker(projectRoot);
      return;
    }
    case 'USAGE_LOG_TAIL': {
      await deps.repairUsageTail(projectRoot);
      return;
    }
    case 'STALE_LOCK': {
      for (const p of c.paths ?? []) {
        await fs.promises.rm(p, { recursive: true, force: true });
      }
      return;
    }
    case 'RUNTIME_DIR_MODE': {
      if (runtimeDir !== null) {
        await fs.promises.chmod(runtimeDir, 0o700);
      }
      return;
    }
    default:
      throw new Error(`未対応の修復: ${c.id}`);
  }
}

// ---------------------------------------------------------------------------
// 人間向け出力
// ---------------------------------------------------------------------------

function renderHuman(report: DoctorReport, out: (line: string) => void): void {
  const errors = report.checks.filter((c) => c.severity === 'error');
  const warns = report.checks.filter((c) => c.severity === 'warn');
  const infos = report.checks.filter((c) => c.severity === 'info');

  out(ui.bold(`mnemo doctor — ${report.projectRoot}`));

  if (errors.length === 0 && warns.length === 0 && infos.length === 0) {
    out(ui.success('問題は見つかりませんでした'));
  }

  const line = (c: DoctorCheck, mark: string): void => {
    let suffix = '';
    if (report.fix && c.fixable) {
      suffix = c.fixed === true ? ` ${ui.success('[修復しました]')}` : ` ${ui.warn(`[修復失敗: ${c.fixError ?? ''}]`)}`;
    }
    out(`${mark} ${c.message}${suffix}`);
    for (const p of c.paths ?? []) {
      out(ui.dim(`    - ${p}`));
    }
  };

  for (const c of errors) line(c, ui.error('✖'));
  for (const c of warns) line(c, ui.warn('▲'));
  for (const c of infos) line(c, ui.dim('·'));

  // 現在値の MCP スニペットは常に表示(設計 §9-5)。
  if (report.snippetStale !== null) {
    out('');
    out(`${ui.bold('現在の MCP 連携スニペット')} (${report.snippetStale.serverKey})`);
    out(ui.dim('Claude 設定ファイルの "mcpServers" に貼り付けてください(既存キーは消さない。doctor は書き換えません)'));
    out(report.snippetStale.currentSnippet);
  }

  if (report.fix) {
    const fixed = report.checks.filter((c) => c.fixed === true).length;
    const failed = report.checks.filter((c) => c.fixable && c.fixed === false).length;
    out('');
    out(ui.dim(`--fix: ${fixed} 件修復 / ${failed} 件失敗`));
  }
}
