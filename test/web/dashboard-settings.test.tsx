// test/web/dashboard-settings.test.tsx — DashboardPage / SettingsPage の単体テスト(設計 §13-15)。
//
// 実行環境: jsdom + @testing-library/react(vitest.config.ts の web プロジェクト)。
//
// カバー観点(§13-15 / タスク test_points):
//   - DashboardPage: データ 0 件でもグラフ枠が描画される / `skippedLogLines` 注記
//   - UsageCharts: 固定サイズ + 0 件データで <svg> が出る
//   - ProjectInfoPanel: projectRoot / vault パス / node_modules 状態を表示のみ・入力要素なし
//   - SettingsPage セクション4: `organizeRecoveryPending`(自動 restore ボタン無し)/ `watcherDown` 行
//   - McpSnippetPanel: クライアントタブ切替 + クリップボードコピー
//   - 再インデックス: `POST /api/reindex` → 完了トースト

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';

import { ToastProvider, Toaster } from '../../src/web/src/context/ToastContext.js';
import DashboardPage from '../../src/web/src/routes/DashboardPage.js';
import SettingsPage from '../../src/web/src/routes/SettingsPage.js';
import { UsageCharts } from '../../src/web/src/components/UsageCharts.js';
import { ProjectInfoPanel } from '../../src/web/src/components/ProjectInfoPanel.js';
import { McpSnippetPanel } from '../../src/web/src/components/McpSnippetPanel.js';
import type {
  ConfigResponse,
  DashboardResponse,
  HealthIssuesResponse,
  McpSnippetResponse,
} from '../../src/web/src/api.js';

// --- 固定フィクスチャ ------------------------------------------------------

const EMPTY_DASHBOARD: DashboardResponse = {
  range: { from: '', to: '' },
  totals: { store: 0, organize: 0, show: 0, notesCreated: 0, notesDeleted: 0 },
  storeCountByDay: [],
  notesByCategory: [],
  modeCountByMonth: [],
  lastUsedAt: { store: null, organize: null, show: null },
  skippedLogLines: 0,
  noteCount: 0,
  categoryCount: 0,
};

const CONFIG: ConfigResponse = {
  projectRoot: '/home/u/my-brain',
  vaultPath: '/home/u/my-brain/vault',
  noteCount: 12,
  indexBuiltAt: '2026-09-01T00:00:00.000Z',
  serverPort: 4123,
};

const NO_ISSUES: HealthIssuesResponse = {
  parseErrors: [],
  conflicts: [],
  vaultMarkerMissing: false,
  nodeModulesMissing: false,
  indexStale: 0,
  watcherDown: false,
  organizeRecoveryPending: null,
};

const SNIPPET_DESKTOP: McpSnippetResponse = {
  serverKey: 'mnemotheca-mybrain-ab12cd',
  snippet: '{\n  "mcpServers": {\n    "mnemotheca-mybrain-ab12cd": { "command": "/usr/bin/node" }\n  }\n}',
  filename: 'claude_desktop_config.json',
};

const SNIPPET_CODE: McpSnippetResponse = {
  ...SNIPPET_DESKTOP,
  filename: '.mcp.json',
};

// --- fetch モック --------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface FetchOverrides {
  dashboard?: DashboardResponse;
  config?: ConfigResponse;
  issues?: HealthIssuesResponse;
  reindex?: unknown;
  healthz?: unknown;
}

let reindexCalls: unknown[] = [];

function installFetch(o: FetchOverrides = {}): void {
  reindexCalls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('/api/dashboard')) return jsonResponse(o.dashboard ?? EMPTY_DASHBOARD);
      if (url.startsWith('/api/config/mcp-snippet')) {
        return jsonResponse(url.includes('client=code') ? SNIPPET_CODE : SNIPPET_DESKTOP);
      }
      if (url.startsWith('/api/config')) return jsonResponse(o.config ?? CONFIG);
      if (url.startsWith('/api/health/issues')) return jsonResponse(o.issues ?? NO_ISSUES);
      if (url.startsWith('/api/reindex')) {
        reindexCalls.push(init?.body != null ? JSON.parse(String(init.body)) : {});
        return jsonResponse(o.reindex ?? { added: 1, updated: 2, removed: 0, tookMs: 5 });
      }
      if (url.startsWith('/healthz')) {
        return jsonResponse(o.healthz ?? { ok: true, name: 'mnemotheca', version: '0.4.2' });
      }
      return jsonResponse({});
    }),
  );
}

function Providers({ children }: { children: ReactNode }): ReactElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <ToastProvider>
        {children}
        <Toaster />
      </ToastProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// --- DashboardPage -------------------------------------------------------

describe('DashboardPage', () => {
  it('renders all chart frames even with zero data', async () => {
    render(
      <Providers>
        <DashboardPage />
      </Providers>,
    );

    expect(await screen.findByText('保存件数の推移(日次)')).toBeDefined();
    expect(screen.getByText('カテゴリ別ノート数')).toBeDefined();
    expect(screen.getByText('モード別回数(月次・積み上げ)')).toBeDefined();
    // 最終利用日カード(0 件でも枠を出す)
    expect(screen.getByTestId('last-used-store').textContent).toContain('—');
    // 期間フィルタ
    expect(screen.getByRole('button', { name: '全期間' })).toBeDefined();
    expect(screen.getByRole('button', { name: '今月' })).toBeDefined();
  });

  it('shows the skippedLogLines note when > 0', async () => {
    installFetch({ dashboard: { ...EMPTY_DASHBOARD, skippedLogLines: 3 } });
    render(
      <Providers>
        <DashboardPage />
      </Providers>,
    );
    expect(await screen.findByText(/3 行のログを読み取れませんでした/)).toBeDefined();
  });

  it('does not show the skippedLogLines note when 0', async () => {
    render(
      <Providers>
        <DashboardPage />
      </Providers>,
    );
    await screen.findByText('カテゴリ別ノート数');
    expect(screen.queryByText(/ログを読み取れませんでした/)).toBeNull();
  });
});

// --- UsageCharts (固定サイズ) -------------------------------------------

describe('UsageCharts', () => {
  it('renders <svg> chart frames with fixed size and zero data', async () => {
    const { container } = render(<UsageCharts data={EMPTY_DASHBOARD} width={400} height={200} />);
    await waitFor(() => {
      expect(container.querySelectorAll('svg').length).toBeGreaterThanOrEqual(3);
    });
  });
});

// --- ProjectInfoPanel --------------------------------------------------

describe('ProjectInfoPanel', () => {
  it('shows projectRoot / vault path / node_modules status with NO input elements', () => {
    const { container } = render(
      <ProjectInfoPanel config={CONFIG} nodeModulesMissing={false} />,
    );
    expect(screen.getByText('/home/u/my-brain')).toBeDefined();
    expect(screen.getByText('/home/u/my-brain/vault')).toBeDefined();
    expect(screen.getByText('あり')).toBeDefined();

    expect(container.querySelectorAll('input, select, textarea').length).toBe(0);
    expect(container.querySelectorAll('button').length).toBe(0);
  });

  it('flags a missing node_modules/mnemo', () => {
    render(<ProjectInfoPanel config={CONFIG} nodeModulesMissing={true} />);
    expect(screen.getByText(/なし/)).toBeDefined();
  });

  it('shows a pending state while nodeModulesMissing is unknown', () => {
    render(<ProjectInfoPanel config={CONFIG} />);
    expect(screen.getByText('確認中…')).toBeDefined();
  });
});

// --- SettingsPage セクション4: 診断 -----------------------------------

describe('SettingsPage diagnostics', () => {
  it('shows the organize-recovery row with NO automatic restore button, plus watcherDown row', async () => {
    installFetch({
      issues: {
        ...NO_ISSUES,
        watcherDown: true,
        organizeRecoveryPending: { snapshotId: 'snap-7', since: '2026-09-01T00:00:00+09:00' },
      },
    });
    render(
      <Providers>
        <SettingsPage />
      </Providers>,
    );

    expect(await screen.findByText(/organize が中断されたままです/)).toBeDefined();
    expect(screen.getByText(/snap-7/)).toBeDefined();
    expect(screen.getByText(/ファイル監視が停止しています/)).toBeDefined();

    // 破壊的操作は MCP 経由の明示承認のみ → UI に自動 restore ボタンは無い。
    expect(screen.queryByRole('button', { name: /復元|元に戻す|restore/i })).toBeNull();
  });

  it('reports "問題は見つかりませんでした" when there are no issues', async () => {
    render(
      <Providers>
        <SettingsPage />
      </Providers>,
    );
    expect(await screen.findByText('問題は見つかりませんでした。')).toBeDefined();
  });
});

// --- SettingsPage セクション5: バージョン情報 -------------------------

describe('SettingsPage version info', () => {
  it('shows the version and the raw healthz JSON', async () => {
    render(
      <Providers>
        <SettingsPage />
      </Providers>,
    );
    expect(await screen.findByText('0.4.2')).toBeDefined();
    expect(screen.getByTestId('healthz-raw').textContent).toContain('"name": "mnemotheca"');
  });
});

// --- SettingsPage セクション3: 再インデックス ------------------------

describe('SettingsPage reindex', () => {
  it('calls POST /api/reindex (diff) and shows a completion toast', async () => {
    const user = (await import('@testing-library/react')).fireEvent;
    render(
      <Providers>
        <SettingsPage />
      </Providers>,
    );
    const btn = await screen.findByRole('button', { name: '差分更新' });
    user.click(btn);

    expect(await screen.findByText(/再インデックス完了(.*追加 1.*更新 2.*削除 0.*)/)).toBeDefined();
    expect(reindexCalls).toEqual([{ full: false }]);
  });

  it('sends full:true for 完全再構築', async () => {
    const { fireEvent } = await import('@testing-library/react');
    render(
      <Providers>
        <SettingsPage />
      </Providers>,
    );
    fireEvent.click(await screen.findByRole('button', { name: '完全再構築' }));
    await waitFor(() => expect(reindexCalls).toEqual([{ full: true }]));
  });
});

// --- McpSnippetPanel --------------------------------------------------

describe('McpSnippetPanel', () => {
  function renderPanel(): ReturnType<typeof render> {
    return render(
      <Providers>
        <McpSnippetPanel />
      </Providers>,
    );
  }

  it('shows the server key + snippet and copies it via navigator.clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    renderPanel();
    expect(await screen.findByText('mnemotheca-mybrain-ab12cd')).toBeDefined();
    expect(screen.getByText('claude_desktop_config.json')).toBeDefined();

    const { fireEvent } = await import('@testing-library/react');
    fireEvent.click(screen.getByRole('button', { name: 'スニペットをコピー' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(SNIPPET_DESKTOP.snippet));
    expect(await screen.findByText('コピーしました')).toBeDefined();
  });

  it('switches the paste-target file when the Claude Code tab is selected', async () => {
    renderPanel();
    await screen.findByText('claude_desktop_config.json');

    const { fireEvent } = await import('@testing-library/react');
    fireEvent.click(screen.getByRole('tab', { name: 'Claude Code' }));

    expect(await screen.findByText('.mcp.json')).toBeDefined();
  });
});
