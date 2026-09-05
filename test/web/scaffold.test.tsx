// test/web/scaffold.test.tsx — SPA 骨格の単体テスト(設計 §13-15)。
//
// 実行環境: jsdom + @testing-library/react(vitest.config.ts の web プロジェクト)。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';

import { appRoutes, AppProviders } from '../../src/web/src/main.js';
import SettingsPage from '../../src/web/src/routes/SettingsPage.js';
import { useReindex } from '../../src/web/src/hooks/queries.js';
import { AuthProvider, TOKEN_STORAGE_KEY } from '../../src/web/src/context/AuthContext.js';
import { useServerEvents } from '../../src/web/src/hooks/useServerEvents.js';
import {
  GlobalErrorBanner,
  reportApiError,
  __resetGlobalErrorForTest,
} from '../../src/web/src/components/GlobalErrorBanner.js';
import { IssuesBanner } from '../../src/web/src/components/IssuesBanner.js';
import { ApiError, type HealthIssuesResponse } from '../../src/web/src/api.js';

// --- EventSource モック -----------------------------------------------------

type Listener = (ev: MessageEvent) => void;

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  closed = false;
  private listeners: Record<string, Listener[]> = {};

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, cb: Listener): void {
    (this.listeners[type] ??= []).push(cb);
  }

  removeEventListener(type: string, cb: Listener): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== cb);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, ev: Partial<MessageEvent>): void {
    for (const cb of this.listeners[type] ?? []) cb(ev as MessageEvent);
  }
}

const NO_ISSUES: HealthIssuesResponse = {
  parseErrors: [],
  conflicts: [],
  vaultMarkerMissing: false,
  nodeModulesMissing: false,
  indexStale: 0,
  watcherDown: false,
  organizeRecoveryPending: null,
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  MockEventSource.instances = [];
  vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => jsonResponse(NO_ISSUES)),
  );
  window.sessionStorage.clear();
  window.history.replaceState({}, '', '/');
  __resetGlobalErrorForTest();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// --- AuthContext -----------------------------------------------------------

describe('AuthContext', () => {
  it('reads ?t= into sessionStorage and strips it from the URL', () => {
    window.history.replaceState({}, '', '/some/path?t=secret-token-123&keep=1');

    render(
      <AuthProvider>
        <div>ok</div>
      </AuthProvider>,
    );

    expect(window.sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBe('secret-token-123');
    expect(window.location.search).toBe('?keep=1');
    expect(window.location.pathname).toBe('/some/path');
  });

  it('keeps an already-stored token when no ?t= is present', () => {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, 'stored-tok');
    window.history.replaceState({}, '', '/');

    render(
      <AuthProvider>
        <div>ok</div>
      </AuthProvider>,
    );

    expect(window.sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBe('stored-tok');
  });
});

// --- useServerEvents ------------------------------------------------------

describe('useServerEvents', () => {
  function Harness(): null {
    useServerEvents();
    return null;
  }

  it('invalidates notes/categories/search/dashboard queries on index-updated', () => {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, 'tok-1');
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue(undefined);

    render(
      <QueryClientProvider client={qc}>
        <AuthProvider>
          <Harness />
        </AuthProvider>
      </QueryClientProvider>,
    );

    expect(MockEventSource.instances).toHaveLength(1);
    const es = MockEventSource.instances[0]!;
    expect(es.url).toBe('/api/events?t=tok-1');

    act(() => {
      es.emit('message', { data: JSON.stringify({ type: 'index-updated' }) });
    });

    const invalidatedKeys = spy.mock.calls.map((c) => (c[0] as { queryKey: string[] }).queryKey[0]);
    expect(invalidatedKeys).toEqual(['notes', 'categories', 'search', 'dashboard']);
  });

  it('ignores non index-updated events', () => {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, 'tok-2');
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue(undefined);

    render(
      <QueryClientProvider client={qc}>
        <AuthProvider>
          <Harness />
        </AuthProvider>
      </QueryClientProvider>,
    );

    act(() => {
      MockEventSource.instances[0]!.emit('message', { data: JSON.stringify({ type: 'ping' }) });
    });

    expect(spy).not.toHaveBeenCalled();
  });

  it('does not open a connection without a token', () => {
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <AuthProvider>
          <Harness />
        </AuthProvider>
      </QueryClientProvider>,
    );
    expect(MockEventSource.instances).toHaveLength(0);
  });
});

// --- routing --------------------------------------------------------------

describe('routing', () => {
  function renderAt(path: string) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createMemoryRouter(appRoutes, { initialEntries: [path] });
    return render(
      <AppProviders client={qc}>
        <RouterProvider router={router} />
      </AppProviders>,
    );
  }

  it('renders NotFoundPage for an unknown path', async () => {
    renderAt('/totally/unknown/path');
    expect(await screen.findByText('ページが見つかりません')).toBeDefined();
  });

  it('renders CategoryListPage at the index route /', async () => {
    // CategoryListPage は実データを引くのでパス別のスタブを与える。
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/api/categories')) {
          return jsonResponse({ tree: [], uncategorizedCount: 0 });
        }
        if (url.includes('/api/notes')) {
          return jsonResponse({ total: 0, items: [] });
        }
        return jsonResponse(NO_ISSUES);
      }),
    );
    renderAt('/');
    expect(await screen.findByRole('region', { name: 'カテゴリ別ノート一覧' })).toBeDefined();
  });
});

// --- GlobalErrorBanner (vault 503) ---------------------------------------

describe('GlobalErrorBanner', () => {
  it('shows the doctor hint after a vault 503 is reported', () => {
    render(<GlobalErrorBanner />);
    expect(screen.queryByRole('alert')).toBeNull();

    act(() => {
      reportApiError(new ApiError(503, 'VAULT_UNAVAILABLE', 'vault missing'));
    });

    const banner = screen.getByRole('alert');
    expect(banner.textContent).toContain('mnemo doctor');
  });

  it('ignores non-vault errors', () => {
    render(<GlobalErrorBanner />);
    act(() => {
      reportApiError(new ApiError(500, 'INTERNAL', 'boom'));
      reportApiError(new ApiError(404, 'NOT_FOUND', 'nope'));
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

// --- queries hooks --------------------------------------------

describe('useReindex / useHealthz', () => {
  it('useReindex invalidates notes/categories/search/dashboard and clears the vault banner on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ added: 0, updated: 0, removed: 0, tookMs: 1 })),
    );
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue(undefined);

    act(() => {
      reportApiError(new ApiError(503, 'VAULT_UNAVAILABLE', 'vault missing'));
    });
    expect(screen.queryByRole('alert')).toBeNull(); // banner not rendered yet

    let hook: ReturnType<typeof useReindex> | undefined;
    function Harness(): null {
      hook = useReindex();
      return null;
    }
    render(
      <QueryClientProvider client={qc}>
        <GlobalErrorBanner />
        <Harness />
      </QueryClientProvider>,
    );

    expect(screen.getByRole('alert')).toBeDefined(); // vault 503 banner up

    await act(async () => {
      await hook!.mutateAsync({ full: false });
    });

    const keys = spy.mock.calls.map((c) => (c[0] as { queryKey: string[] }).queryKey[0]);
    expect(keys).toEqual(['notes', 'categories', 'search', 'dashboard']);
    expect(screen.queryByRole('alert')).toBeNull(); // clearGlobalError() ran
  });

  it('VersionInfo shows a fallback message when /healthz fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/healthz')) return new Response('nope', { status: 500 });
        if (url.includes('/api/config')) {
          return jsonResponse({
            projectRoot: '/p',
            vaultPath: '/p/vault',
            noteCount: 0,
            indexBuiltAt: null,
            serverPort: 1,
          });
        }
        return jsonResponse(NO_ISSUES);
      }),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <AppProviders client={qc}>
        <SettingsPage />
      </AppProviders>,
    );

    expect(await screen.findByText('バージョン情報を取得できません')).toBeDefined();
  });
});

// --- IssuesBanner --------------------------------------------------------

describe('IssuesBanner', () => {
  function renderWithIssues(issues: HealthIssuesResponse) {
    const qc = new QueryClient();
    qc.setQueryData(['issues'], issues);
    return render(
      <QueryClientProvider client={qc}>
        <IssuesBanner />
      </QueryClientProvider>,
    );
  }

  it('shows an organize-recovery row with NO automatic restore button', () => {
    renderWithIssues({
      ...NO_ISSUES,
      organizeRecoveryPending: { snapshotId: 'snap-42', since: '2026-09-01T00:00:00+09:00' },
    });

    expect(screen.getByText(/organize が中断されたままです/)).toBeDefined();
    expect(screen.getByText(/snap-42/)).toBeDefined();
    // 破壊的操作は MCP 経由のみ → バナーにボタンは無い(§13-15)。
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows a "ファイル監視停止" row when watcherDown', () => {
    renderWithIssues({ ...NO_ISSUES, watcherDown: true });
    expect(screen.getByText(/ファイル監視停止/)).toBeDefined();
  });

  it('renders parseErrors / conflicts / indexStale counts', () => {
    renderWithIssues({
      ...NO_ISSUES,
      parseErrors: [{ path: 'a.md', detectedAt: '', message: 'x', kind: 'schema' }],
      conflicts: [{ path: 'b.md', detectedAt: '', reason: 'dup' }],
      indexStale: 3,
    });
    expect(screen.getByText(/frontmatter を解析できないノート: 1 件/)).toBeDefined();
    expect(screen.getByText(/重複の可能性があるノート: 1 件/)).toBeDefined();
    expect(screen.getByText(/インデックス未反映のノート: 3 件/)).toBeDefined();
  });

  it('renders nothing when there are no issues', () => {
    const { container } = renderWithIssues(NO_ISSUES);
    expect(container.textContent).toBe('');
  });
});
