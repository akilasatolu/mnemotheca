// src/web/src/hooks/queries.ts — React Query フック群(設計 §11-5)。
//
// staleTime(§11-5):
//   - 一覧 / カテゴリ: 30s
//   - 検索: 0(都度)
//   - config / issues: 10s
//   - rendered: 5min
//   - dashboard: 明記なし → 一覧に準拠し 30s
//
// queryKey は §11-5 の例に一致させる:
//   ['notes', {category,tag,sort,order}] / ['note', id] / ['rendered', id] /
//   ['categories'] / ['search', q, filters] / ['dashboard', range] / ['config'] / ['issues']

import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import {
  fetchCategories,
  fetchConfig,
  fetchDashboard,
  fetchHealthIssues,
  fetchHealthz,
  fetchMcpSnippet,
  fetchNote,
  fetchNotes,
  fetchRenderedNote,
  fetchSearch,
  postReindex,
  type CategoriesResponse,
  type ConfigResponse,
  type DashboardResponse,
  type HealthIssuesResponse,
  type HealthzResponse,
  type McpSnippetResponse,
  type NoteDetail,
  type NoteListResponse,
  type NotesQuery,
  type ReindexBody,
  type ReindexResponse,
  type RenderedNote,
  type SearchResponse,
} from '../api.js';
import { clearGlobalError } from '../components/GlobalErrorBanner.js';

export const STALE = {
  list: 30_000,
  categories: 30_000,
  search: 0,
  config: 10_000,
  issues: 10_000,
  rendered: 300_000,
  dashboard: 30_000,
  // §11-5 に明記なし。config / issues 相当の 10s(表示専用のバージョン情報)。
  healthz: 10_000,
  mcpSnippet: 10_000,
} as const;

export function useNotes(params: NotesQuery = {}): UseQueryResult<NoteListResponse> {
  return useQuery({
    queryKey: ['notes', params],
    queryFn: () => fetchNotes(params),
    staleTime: STALE.list,
    // ソート / カテゴリ切替のたびに一覧が空へ落ちてスケルトンが挟まるのを防ぐ。
    placeholderData: keepPreviousData,
  });
}

export function useNote(id: string | undefined): UseQueryResult<NoteDetail> {
  return useQuery({
    queryKey: ['note', id],
    queryFn: () => fetchNote(id as string),
    enabled: id !== undefined && id !== '',
    staleTime: STALE.list,
  });
}

export function useRenderedNote(id: string | undefined): UseQueryResult<RenderedNote> {
  return useQuery({
    queryKey: ['rendered', id],
    queryFn: () => fetchRenderedNote(id as string),
    enabled: id !== undefined && id !== '',
    staleTime: STALE.rendered,
  });
}

export function useCategories(): UseQueryResult<CategoriesResponse> {
  return useQuery({
    queryKey: ['categories'],
    queryFn: fetchCategories,
    staleTime: STALE.categories,
  });
}

export interface SearchFilters {
  category?: string;
  tag?: string;
}

export function useSearch(q: string, filters: SearchFilters = {}): UseQueryResult<SearchResponse> {
  const trimmed = q.trim();
  return useQuery({
    queryKey: ['search', trimmed, filters],
    queryFn: () => fetchSearch({ q: trimmed, ...filters }),
    enabled: trimmed.length >= 2,
    staleTime: STALE.search,
    placeholderData: keepPreviousData,
  });
}

export function useDashboard(range: { from?: string; to?: string } = {}): UseQueryResult<DashboardResponse> {
  return useQuery({
    queryKey: ['dashboard', range],
    queryFn: () => fetchDashboard(range),
    staleTime: STALE.dashboard,
  });
}

export function useConfig(): UseQueryResult<ConfigResponse> {
  return useQuery({
    queryKey: ['config'],
    queryFn: fetchConfig,
    staleTime: STALE.config,
  });
}

export function useIssues(): UseQueryResult<HealthIssuesResponse> {
  return useQuery({
    queryKey: ['issues'],
    queryFn: fetchHealthIssues,
    staleTime: STALE.issues,
  });
}

/** `GET /healthz`(無認証)。SettingsPage のバージョン情報表示専用。失敗しても致命ではない。 */
export function useHealthz(): UseQueryResult<HealthzResponse> {
  return useQuery({
    queryKey: ['healthz'],
    queryFn: fetchHealthz,
    staleTime: STALE.healthz,
    retry: false,
  });
}

/** `GET /api/config/mcp-snippet?client=`。SettingsPage の MCP 連携パネル用。 */
export function useMcpSnippet(client: 'desktop' | 'code'): UseQueryResult<McpSnippetResponse> {
  return useQuery({
    queryKey: ['mcp-snippet', client],
    queryFn: () => fetchMcpSnippet(client),
    staleTime: STALE.mcpSnippet,
  });
}

/**
 * `POST /api/reindex` の mutation。成功時に一覧 / カテゴリ / 検索 / ダッシュボードの
 * キャッシュを無効化し(§11-5 の SSE `index-updated` と同じ 4 キー)、vault エラーバナーを
 * 明示的にクリアする(再インデックス成功 = vault 復帰の可能性が高い)。
 */
export function useReindex(): UseMutationResult<ReindexResponse, unknown, ReindexBody> {
  const queryClient = useQueryClient();
  return useMutation<ReindexResponse, unknown, ReindexBody>({
    mutationFn: (body) => postReindex(body),
    onSuccess: () => {
      for (const key of [['notes'], ['categories'], ['search'], ['dashboard']]) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
      clearGlobalError();
    },
  });
}
