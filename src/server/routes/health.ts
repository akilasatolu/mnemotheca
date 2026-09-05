// src/server/routes/health.ts — `GET /healthz`(無認証。設計 §10-1 エンドポイント表 / §2-3)。
//
// 責務: 稼働確認用の 1 エンドポイントのみ。認証・ヘッダ付与・静的配信は `server/app.ts`
// が担当する(このモジュールはルート定義だけを持つ)。
//
// **マウント位置**: `/healthz` は `/api` 配下ではない(無認証)。`createApp` の `apiRouter`
// 引数(`/api` にマウントされる)には渡せないため、結線タスク側で app 直下に
// `app.route('/', healthRoutes(deps))` 相当でマウントする。現状 `server/app.ts` は
// 同等の `/healthz` を内蔵しているので、本モジュールはその差し替え候補(drop-in)。
//
// レスポンス形は設計 §10-1 の表に厳密に一致させる:
//   `{ ok: true, name: 'mnemotheca', version, projectRoot, vaultPath, port, startedAt }`
//
// このモジュールは加えて `GET /api/health/issues`(認証必須・診断バナー用。設計 §10-1 /
// §11-4 `IssuesBanner` / §13-12 / §13-13)を `createHealthIssuesRoutes(deps)` として提供する。
// `/healthz`(無認証)とは別の Hono を返し、結線側(`server/mount.ts`)が `/api` 配下に
// マウントする(認証は `server/app.ts` の `/api/*` ミドルウェアが担当)。
//
// 規約: ESM / NodeNext / strict / verbatimModuleSyntax / noUncheckedIndexedAccess。

import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { mnemothecaPaths, vaultPaths } from '../../core/paths.js';

/** `healthRoutes` の依存(結線タスク / boot.ts が生成して渡す。設計 §10-1「認証」の deps と同源)。 */
export interface HealthRouteDeps {
  /** projectRoot 絶対パス。 */
  projectRoot: string;
  /** vault パス(既定 `<projectRoot>/vault`)。 */
  vaultPath: string;
  /** listen 中のポート。 */
  port: number;
  /** サーバー起動時刻(ISO 文字列)。 */
  startedAt: string;
  /** 表示用バージョン(`package.json` の version 相当)。 */
  version: string;
}

/** §10-1 の healthz レスポンス schema。 */
export interface HealthzResponse {
  ok: true;
  name: 'mnemotheca';
  version: string;
  projectRoot: string;
  vaultPath: string;
  port: number;
  startedAt: string;
}

/**
 * `GET /healthz` だけを持つ Hono サブアプリを返す(無認証)。
 *
 * `mnemo_show` / SPA 初期ロード / boot のセルフチェックが叩く(設計 §3-3 / §3-4 / §12-6)。
 * 認証ヘッダの有無に関わらず 200 を返す(認証ミドルウェアは `/api/*` のみ・§10-1)。
 */
export function createHealthRoutes(deps: HealthRouteDeps): Hono {
  const r = new Hono();

  r.get('/healthz', (c) => {
    const body: HealthzResponse = {
      ok: true,
      name: 'mnemotheca',
      version: deps.version,
      projectRoot: deps.projectRoot,
      vaultPath: deps.vaultPath,
      port: deps.port,
      startedAt: deps.startedAt,
    };
    return c.json(body);
  });

  return r;
}

// ---------------------------------------------------------------------------
// GET /api/health/issues(認証必須。設計 §10-1 / §11-4 / §12-2 / §12-10)
// ---------------------------------------------------------------------------

/** `organize-session.json` 中断検出の要約(設計 §12-10 表 #3 / §10-1)。 */
export interface OrganizeRecoveryPendingView {
  /** `restoreSnapshot` 対象(`<label>-<ts>`)。 */
  snapshotId: string;
  /** 中断 organize の scan 時刻(ISO 文字列)。 */
  since: string;
}

/** `parse-errors.json`(設計 §10-6)の 1 エントリ。 */
export interface ParseErrorEntry {
  path: string;
  detectedAt: string;
  message: string;
  kind: string;
}

/** `conflicts.json`(設計 §10-6)の 1 エントリ。 */
export interface ConflictEntry {
  path: string;
  detectedAt: string;
  reason: string;
  dupOf?: string;
}

/** §10-1 `GET /api/health/issues` レスポンス schema(`IssuesBanner` / SettingsPage セクション4 が読む)。 */
export interface HealthIssuesResponse {
  parseErrors: ParseErrorEntry[];
  conflicts: ConflictEntry[];
  vaultMarkerMissing: boolean;
  nodeModulesMissing: boolean;
  /** `meta.json.builtAt` より新しい `.md` ノート数(簡易鮮度判定。設計 §10-1 `indexStale: n`)。 */
  indexStale: number;
  watcherDown: boolean;
  organizeRecoveryPending: OrganizeRecoveryPendingView | null;
}

/** `createHealthIssuesRoutes` の依存(`server/mount.ts` が boot 由来の値を渡す)。 */
export interface HealthIssuesRouteDeps {
  /** projectRoot 絶対パス。 */
  projectRoot: string;
  /** vault パス(既定 `<projectRoot>/vault`)。 */
  vaultPath: string;
  /**
   * watcher が縮退し監視停止中か(watcher の `isDown()`。設計 §6-5 / §10-1)。
   * 未配線時は `false` 扱い。
   */
  watcherIsDown?: () => boolean;
  /**
   * 中断 organize の有無を返す(設計 §12-10 表 #3。boot が `organize-session.json` を
   * 読み取り専用で判定)。省略 / null 時は `organizeRecoveryPending: null`。
   */
  getOrganizeRecoveryPending?: () => Promise<OrganizeRecoveryPendingView | null>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** JSON 配列ファイルを読む。無い / 破損 / 非配列 → `[]`(診断用途なので致命ではない)。 */
async function readJsonArray(file: string): Promise<Record<string, unknown>[]> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(file, 'utf8');
  } catch {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecord);
  } catch {
    return [];
  }
}

/** `<indexDir>/meta.json` の `builtAt`(ISO 文字列)。無い / 破損 → `null`。 */
async function readIndexBuiltAt(metaJson: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(metaJson, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    return typeof parsed.builtAt === 'string' ? parsed.builtAt : null;
  } catch {
    return null;
  }
}

/**
 * `knowledgeDir` 配下(ドット要素除外)の `.md` で mtime が `builtAtMs` より新しいものを数える。
 * `builtAtMs` が `null`(meta 無し)なら 0 を返す(未ビルドは別条件。簡易判定・設計「簡易でよい」)。
 */
async function countStaleNotes(knowledgeDir: string, builtAtMs: number | null): Promise<number> {
  if (builtAtMs === null) return 0;
  let count = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        try {
          const st = await fs.promises.stat(full);
          if (st.mtimeMs > builtAtMs) count += 1;
        } catch {
          /* noop */
        }
      }
    }
  };
  await walk(knowledgeDir);
  return count;
}

/**
 * `GET /api/health/issues` だけを持つ Hono サブアプリを返す(認証必須。`/api` 配下にマウント)。
 *
 * すべて読み取り専用・best-effort で、いかなる分岐でも 200 を返す(`mnemo doctor` 相当の
 * 問題一覧。設計 §10-1)。ファイルは一切書き換えない。
 */
export function createHealthIssuesRoutes(deps: HealthIssuesRouteDeps): Hono {
  const r = new Hono();

  r.get('/health/issues', async (c) => {
    const mp = mnemothecaPaths(deps.projectRoot);
    const vp = vaultPaths(deps.projectRoot);

    const [parseErrorsRaw, conflictsRaw, builtAt, organizeRecoveryPending] = await Promise.all([
      readJsonArray(mp.parseErrorsJson),
      readJsonArray(mp.conflictsJson),
      readIndexBuiltAt(mp.metaJson),
      deps.getOrganizeRecoveryPending ? deps.getOrganizeRecoveryPending() : Promise.resolve(null),
    ]);

    const parsedBuiltAt = builtAt === null ? NaN : Date.parse(builtAt);
    const builtAtMs = Number.isNaN(parsedBuiltAt) ? null : parsedBuiltAt;
    const indexStale = await countStaleNotes(vp.knowledgeDir, builtAtMs);

    const body: HealthIssuesResponse = {
      parseErrors: parseErrorsRaw as unknown as ParseErrorEntry[],
      conflicts: conflictsRaw as unknown as ConflictEntry[],
      vaultMarkerMissing: !fs.existsSync(vp.markerJson),
      // `node_modules/mnemo`(npm 依存としてインストールした本体)の有無。doctor.ts の
      // DIST_MISSING と同じ判定。
      nodeModulesMissing: !fs.existsSync(path.join(deps.projectRoot, 'node_modules', 'mnemo')),
      indexStale,
      watcherDown: deps.watcherIsDown?.() ?? false,
      organizeRecoveryPending: organizeRecoveryPending ?? null,
    };
    return c.json(body);
  });

  return r;
}

export default createHealthRoutes;
