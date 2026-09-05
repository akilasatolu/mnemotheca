// src/core/errors.ts — 異常系設計の中核(設計書 §12-1)。
//
// すべての想定内エラーは `MnemoError` として throw し、CLI / HTTP / MCP の 3 面が
// `code` を見て一貫した提示を行う。`code` は `ErrorCode` union の 26 種ちょうど。
//
// 注意: `NODE_MODULES_STALE` は `ErrorCode` に **含めない**。「clone = プロジェクト」方式
// (npm git-dependency を使わない)への移行により `mnemo doctor` はこのチェックを行わなく
// なったが、コード自体は将来の用途に備えて union には追加していない
// (`SNIPPET_STALE` とは異なり union にも入らない。設計書 §9-5-1 / §9-1 doctor 行)。

/**
 * 想定内の障害を表すエラーコード(設計書 §12-1)。総数 **26**。
 *
 * 各コードの主な throw 箇所(設計書 §12-1 のテーブル):
 * - `NOT_INITIALIZED`            … `resolveProjectRoot`(§8-A)
 * - `CONFIG_CORRUPT`             … `loadConfig`(§8-B)
 * - `PROJECT_NOT_WRITABLE`       … `mnemothecaPaths` 書き込み系(§8-A)
 * - `VAULT_UNAVAILABLE`          … `checkVault`(§12-2)、store/organize/show ハンドラ冒頭
 * - `VAULT_NOT_WRITABLE`         … `checkVault`(§12-2)、同上
 * - `NODE_MODULES_MISSING`       … CLI 各コマンドの前段チェック(§12-2)
 * - `RUNTIME_DIR_UNWRITABLE`     … `ensureRuntimeDir` / `runtimeBase`(§8-A)
 * - `LOCK_TIMEOUT`               … `withLock`(§8-G)
 * - `FRONTMATTER_PARSE`          … `parseNote`(§8-C)、store apply の書き込み前検証(§12-4)
 * - `FRONTMATTER_SCHEMA`         … `validateFrontmatter`(§8-C)、store apply 書き込み前検証(§12-4)
 * - `CATEGORY_INVARIANT`         … `assertCategoryPathInvariant`(§10-2-3)
 * - `SLUG_COLLISION`             … `resolveCollision`(strategy=`abort`、§8-E)、store apply(§8-M)
 * - `SLUG_INVALID`               … `mnemo_store` ハンドラの `isValidSlug` 保険チェック(§12-1)
 * - `PII_BLOCKED`               … `scanPii().blocks.length > 0`(store/organize apply、§7)
 * - `ORGANIZE_SESSION_EXPIRED`   … organize preview/apply の sessionId 照合 / `expiresAt` /
 *                                  `applying:true` 検出 / session JSON 破損退避時(§8-N / §10-5 / §12-10)
 * - `DESTRUCTIVE_NOT_CONFIRMED`  … organize apply step 2(§8-N)
 * - `PROPOSAL_CONFLICT`          … organize preview/apply step 3 の FileOp 矛盾チェック(§8-N)
 * - `SNAPSHOT_FAILED`            … `createSnapshot`(§8-H)、`restoreSnapshot` 失敗時(§8-N / §12-10)
 * - `PORT_UNAVAILABLE`           … `boot.ts` / `mnemo_show`(§12-5)
 * - `SERVER_START_TIMEOUT`       … デタッチ起動で `/healthz` が応答しない(§12-5)
 * - `BROWSER_OPEN_FAILED`        … 列挙のみ(throw せず `browserOpened:false`、§12-7)
 * - `INDEX_BUILD_FAILED`         … `buildIndex`(§12-11)
 * - `QUERY_TOO_SHORT`            … `/api/search` / `core/search.search` 前段(§5-3)
 * - `NODE_VERSION_UNSUPPORTED`   … `startMcpStdio` 冒頭 / CLI 冒頭(§8-L、§12-13)
 * - `SNIPPET_STALE`              … `mnemo doctor` のみ(warn・exit 0、§9-5)
 * - `UNAUTHORIZED`               … HTTP 認証ミドルウェア(§10-1)
 */
export type ErrorCode =
  | 'NOT_INITIALIZED'
  | 'CONFIG_CORRUPT'
  | 'PROJECT_NOT_WRITABLE'
  | 'VAULT_UNAVAILABLE'
  | 'VAULT_NOT_WRITABLE'
  | 'NODE_MODULES_MISSING'
  | 'RUNTIME_DIR_UNWRITABLE'
  | 'LOCK_TIMEOUT'
  | 'FRONTMATTER_PARSE'
  | 'FRONTMATTER_SCHEMA'
  | 'CATEGORY_INVARIANT'
  | 'SLUG_COLLISION'
  | 'SLUG_INVALID'
  | 'PII_BLOCKED'
  | 'ORGANIZE_SESSION_EXPIRED'
  | 'DESTRUCTIVE_NOT_CONFIRMED'
  | 'PROPOSAL_CONFLICT'
  | 'SNAPSHOT_FAILED'
  | 'PORT_UNAVAILABLE'
  | 'SERVER_START_TIMEOUT'
  | 'BROWSER_OPEN_FAILED'
  | 'INDEX_BUILD_FAILED'
  | 'QUERY_TOO_SHORT'
  | 'NODE_VERSION_UNSUPPORTED'
  | 'SNIPPET_STALE'
  | 'UNAUTHORIZED';

/**
 * `ErrorCode` の全メンバーを実行時にも列挙できる配列(26 種ちょうど)。
 * union の網羅チェックや doctor の `--json` 出力などで利用する。
 * 要素の増減があれば `ErrorCode` union との相互チェックで型エラーになる。
 */
export const ERROR_CODES = [
  'NOT_INITIALIZED',
  'CONFIG_CORRUPT',
  'PROJECT_NOT_WRITABLE',
  'VAULT_UNAVAILABLE',
  'VAULT_NOT_WRITABLE',
  'NODE_MODULES_MISSING',
  'RUNTIME_DIR_UNWRITABLE',
  'LOCK_TIMEOUT',
  'FRONTMATTER_PARSE',
  'FRONTMATTER_SCHEMA',
  'CATEGORY_INVARIANT',
  'SLUG_COLLISION',
  'SLUG_INVALID',
  'PII_BLOCKED',
  'ORGANIZE_SESSION_EXPIRED',
  'DESTRUCTIVE_NOT_CONFIRMED',
  'PROPOSAL_CONFLICT',
  'SNAPSHOT_FAILED',
  'PORT_UNAVAILABLE',
  'SERVER_START_TIMEOUT',
  'BROWSER_OPEN_FAILED',
  'INDEX_BUILD_FAILED',
  'QUERY_TOO_SHORT',
  'NODE_VERSION_UNSUPPORTED',
  'SNIPPET_STALE',
  'UNAUTHORIZED',
] as const satisfies readonly ErrorCode[];

// `ERROR_CODES` が `ErrorCode` を漏れなく含むことをコンパイル時に保証する
// (どちらか一方だけに追加すると型エラーになる)。
type _AllCodesCovered = Exclude<ErrorCode, (typeof ERROR_CODES)[number]> extends never
  ? true
  : never;
const _allCodesCovered: _AllCodesCovered = true;
void _allCodesCovered;

/**
 * Mnemo の想定内エラー(設計書 §12-1)。
 *
 * ```ts
 * throw new MnemoError('LOCK_TIMEOUT', undefined, { scope: 'knowledge' });
 * ```
 *
 * - `code`    … `ErrorCode`。CLI / HTTP / MCP はこれを見て提示を切り替える。
 * - `message` … 省略時は `code` 文字列がそのまま `Error.message` になる。
 * - `details` … 補足情報(対処に必要なパスやフィールド名など)。任意。
 *
 * ## CLI / HTTP / MCP 3 面の共通マッピング(設計書 §12-1 末尾)
 *
 * - **MCP tool**: `MnemoError` を catch し
 *   `{ content: [{ type: 'text', text: 説明 + 対処 }], isError: true,
 *      structuredContent: { code, details } }` を返す。
 *   Claude がユーザーに対処を伝えられるよう text は日本語で具体的に書く。
 * - **HTTP**: `MnemoError` → §10-1 のエラー形式(`{ error: { code, message, details } }`)+
 *   `code` に対応する HTTP ステータス。`UNAUTHORIZED` は 401、`VAULT_UNAVAILABLE` /
 *   `VAULT_NOT_WRITABLE` は 503、`QUERY_TOO_SHORT` は 400、`FRONTMATTER_*` は 422 など。
 * - **CLI**: `MnemoError` → stderr に赤字でメッセージ +
 *   「次のコマンドで解決できます: ...」を出力し、exit code 1。
 *
 * 具体的な status / text / 解決コマンドの割り当ては提示を行う各層
 * (`mcp/*`、`server/*`、`cli/*`)が担当する。`core/errors.ts` は
 * `code` / `message` / `details` の運搬のみに責務を限定する(設計書 §12-1 に
 * 共通マッピング関数の定義は無い)。
 */
export class MnemoError extends Error {
  override readonly name = 'MnemoError';

  constructor(
    public readonly code: ErrorCode,
    message?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message ?? code);
    // ES2022 / target ES2022 では extends Error でも prototype は正しく張られるが、
    // 明示しておく(down-level 時の instanceof 対策)。
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** `unknown` を `MnemoError` に絞り込む型ガード。 */
export function isMnemoError(err: unknown): err is MnemoError {
  return err instanceof MnemoError;
}
