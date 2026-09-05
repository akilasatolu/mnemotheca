// src/web/src/api.ts — SPA ↔ ローカル HTTP サーバーの fetch ラッパと DTO 型(設計 §10-1)。
//
// - baseURL: `/api`(SPA は同一オリジンから配信されるため相対)
// - 認証: `Authorization: Bearer <token>`。トークンは AuthContext が `setTokenGetter` で供給する
// - エラー: サーバーの共通エラー形式 `{ error: { code, message, details } }` を `ApiError` に変換
// - 各エンドポイント関数と、それらのレスポンス DTO 型をまとめて export(各画面が import する)
//
// 規約: ESM / Bundler resolution / strict / verbatimModuleSyntax。

const BASE_URL = '/api';

/** サーバーの共通エラー形式(§10-1)を表す例外。 */
export class ApiError extends Error {
  constructor(
    /** HTTP ステータス。ネットワーク失敗時は 0。 */
    public readonly status: number,
    /** `error.code`(サーバー未提供時は `HTTP_ERROR` / `NETWORK`)。 */
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

/** AuthContext が現在のトークンを供給するためのフック。既定は null。 */
let tokenGetter: () => string | null = () => null;
export function setTokenGetter(fn: () => string | null): void {
  tokenGetter = fn;
}

interface ServerErrorShape {
  error?: { code?: string; message?: string; details?: Record<string, unknown> };
}

interface RequestOptions {
  /**
   * `true` の場合 `path` を `BASE_URL`(`/api`)配下ではなくオリジン相対でそのまま叩く。
   * `/healthz`(無認証・`/api` 外)専用。エラー変換・Authorization 付与ロジックは共通で通す。
   */
  absolute?: boolean;
}

async function request<T>(path: string, init?: RequestInit, opts?: RequestOptions): Promise<T> {
  const headers = new Headers(init?.headers);
  const token = tokenGetter();
  if (token !== null && token !== '') headers.set('Authorization', `Bearer ${token}`);

  const url = opts?.absolute === true ? path : BASE_URL + path;
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers });
  } catch (e) {
    throw new ApiError(0, 'NETWORK', e instanceof Error ? e.message : 'ネットワークエラー');
  }

  const ct = res.headers.get('content-type') ?? '';
  const payload: unknown = ct.includes('application/json')
    ? await res.json().catch(() => null)
    : null;

  if (!res.ok) {
    const err = (payload as ServerErrorShape | null)?.error;
    throw new ApiError(
      res.status,
      err?.code ?? 'HTTP_ERROR',
      err?.message ?? res.statusText ?? `HTTP ${res.status}`,
      err?.details ?? {},
    );
  }
  return payload as T;
}

function qs(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  }
  const s = sp.toString();
  return s === '' ? '' : `?${s}`;
}

// ---------------------------------------------------------------------------
// DTO 型(サーバー routes/* の実装レスポンスに一致。§10-1 DTO)
// ---------------------------------------------------------------------------

export interface NoteSummary {
  id: string;
  title: string;
  summary: string;
  categories: string[];
  tags: string[];
  created: string;
  updated: string;
  path: string;
}

export interface NoteListResponse {
  total: number;
  items: NoteSummary[];
}

export interface NoteDetail {
  id: string;
  frontmatter: Record<string, unknown>;
  body: string;
  path: string;
}

export interface Heading {
  depth: number;
  text: string;
  slug: string;
}

export interface RenderedNote {
  id: string;
  html: string;
  frontmatter: Record<string, unknown>;
  headings: Heading[];
  /** vault ルート相対パス(`knowledge/<...>/<slug>.md`)。相対リンク解決 / パス表示に使う。 */
  path: string;
}

/** `GET /healthz`(無認証)のレスポンス schema(`src/server/routes/health.ts` 実体に一致)。 */
export interface HealthzResponse {
  ok: boolean;
  name: string;
  version: string;
  projectRoot: string;
  vaultPath: string;
  port: number;
  startedAt: string;
}

export interface CategoryNode {
  path: string;
  name: string;
  title: string;
  noteCount: number;
  children: CategoryNode[];
}

export interface CategoriesResponse {
  tree: CategoryNode[];
  uncategorizedCount: number;
}

export interface SearchResult {
  id: string;
  title: string;
  summary: string;
  categories: string[];
  tags: string[];
  score: number;
  matchedFields: string[];
  snippet: string;
  path: string;
}

export interface SearchResponse {
  query: string;
  took: number;
  total: number;
  results: SearchResult[];
}

export interface UsageStats {
  range: { from: string; to: string };
  totals: {
    store: number;
    organize: number;
    show: number;
    notesCreated: number;
    notesDeleted: number;
  };
  storeCountByDay: { date: string; count: number }[];
  notesByCategory: { category: string; count: number }[];
  modeCountByMonth: { month: string; store: number; organize: number; show: number }[];
  lastUsedAt: { store: string | null; organize: string | null; show: string | null };
  skippedLogLines: number;
}

export interface DashboardResponse extends UsageStats {
  noteCount: number;
  categoryCount: number;
}

export interface ConfigResponse {
  projectRoot: string;
  vaultPath: string;
  noteCount: number;
  indexBuiltAt: string | null;
  serverPort: number;
}

export interface McpSnippetResponse {
  serverKey: string;
  snippet: string;
  filename: string;
}

export interface ReindexResponse {
  added: number;
  updated: number;
  removed: number;
  tookMs: number;
}

export interface ParseErrorEntry {
  path: string;
  detectedAt: string;
  message: string;
  kind: string;
}

export interface ConflictEntry {
  path: string;
  detectedAt: string;
  reason: string;
  dupOf?: string;
}

export interface OrganizeRecoveryPending {
  snapshotId: string;
  since: string;
}

export interface HealthIssuesResponse {
  parseErrors: ParseErrorEntry[];
  conflicts: ConflictEntry[];
  vaultMarkerMissing: boolean;
  nodeModulesMissing: boolean;
  indexStale: number;
  watcherDown: boolean;
  organizeRecoveryPending: OrganizeRecoveryPending | null;
}

// ---------------------------------------------------------------------------
// エンドポイント関数(§10-1 エンドポイント表)
// ---------------------------------------------------------------------------

export interface NotesQuery {
  category?: string;
  tag?: string;
  sort?: 'created' | 'updated' | 'title';
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export function fetchNotes(params: NotesQuery = {}): Promise<NoteListResponse> {
  return request<NoteListResponse>(`/notes${qs({ ...params })}`);
}

export function fetchNote(id: string): Promise<NoteDetail> {
  return request<NoteDetail>(`/notes/${encodeURIComponent(id)}`);
}

export function fetchRenderedNote(id: string): Promise<RenderedNote> {
  return request<RenderedNote>(`/notes/${encodeURIComponent(id)}/rendered`);
}

/** `GET /healthz`(無認証・`/api` 外)。`request` の baseURL を迂回しつつエラー変換は共通。 */
export function fetchHealthz(): Promise<HealthzResponse> {
  return request<HealthzResponse>('/healthz', undefined, { absolute: true });
}

export function fetchCategories(): Promise<CategoriesResponse> {
  return request<CategoriesResponse>('/categories');
}

export interface SearchQuery {
  q: string;
  category?: string;
  tag?: string;
  limit?: number;
}

export function fetchSearch(params: SearchQuery): Promise<SearchResponse> {
  return request<SearchResponse>(`/search${qs({ ...params })}`);
}

export interface DashboardQuery {
  from?: string;
  to?: string;
}

export function fetchDashboard(params: DashboardQuery = {}): Promise<DashboardResponse> {
  return request<DashboardResponse>(`/dashboard${qs({ ...params })}`);
}

export function fetchConfig(): Promise<ConfigResponse> {
  return request<ConfigResponse>('/config');
}

export function fetchMcpSnippet(client: 'desktop' | 'code' = 'desktop'): Promise<McpSnippetResponse> {
  return request<McpSnippetResponse>(`/config/mcp-snippet${qs({ client })}`);
}

export function fetchHealthIssues(): Promise<HealthIssuesResponse> {
  return request<HealthIssuesResponse>('/health/issues');
}

export interface ReindexBody {
  full?: boolean;
  paths?: string[];
}

export function postReindex(body: ReindexBody = {}): Promise<ReindexResponse> {
  return request<ReindexResponse>('/reindex', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
