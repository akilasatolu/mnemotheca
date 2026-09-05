// test/web/category-list.test.tsx — CategoryListPage / CategoryTree / NoteList の単体テスト
// (設計 §13-15)。
//
// 実行環境: jsdom + @testing-library/react(vitest.config.ts の web プロジェクト)。
// fetch は手動モック(URL で分岐)。localStorage は jsdom 実装をそのまま使う。
// 仮想スクロール(react-virtual)は jsdom で 0 高さのため、件数・順序の検証は
// DOM ノード数ではなくデータ層(URL クエリ)/ getByRole で行う。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider, useSearchParams, type RouteObject } from 'react-router-dom';

import CategoryListPage from '../../src/web/src/routes/CategoryListPage.js';
import type { CategoriesResponse, NoteListResponse, NoteSummary } from '../../src/web/src/api.js';

// --- フィクスチャ ---------------------------------------------------------

const CATEGORIES: CategoriesResponse = {
  tree: [
    {
      path: 'tech',
      name: 'tech',
      title: '技術',
      noteCount: 1,
      children: [{ path: 'tech/web', name: 'web', title: 'Web', noteCount: 2, children: [] }],
    },
    { path: 'life', name: 'life', title: '生活', noteCount: 3, children: [] },
  ],
  uncategorizedCount: 4,
};

function note(id: string, over: Partial<NoteSummary> = {}): NoteSummary {
  return {
    id,
    title: `ノート ${id}`,
    summary: `${id} の要約`,
    categories: [],
    tags: [],
    created: '2026-01-01T00:00:00.000Z',
    updated: '2026-02-01T00:00:00.000Z',
    path: `knowledge/${id}.md`,
    ...over,
  };
}

const ALL_NOTES: NoteSummary[] = [
  note('a', { categories: ['tech/web'], tags: ['ts'] }),
  note('b', { categories: ['tech'] }),
  note('c', { categories: [] }),
];

// --- fetch モック --------------------------------------------------------

interface MockOpts {
  notesFor?: (url: URL) => NoteListResponse;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function urlOf(input: RequestInfo | URL): URL {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return new URL(raw, 'http://localhost');
}

function installFetch(opts: MockOpts = {}): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = urlOf(input);
    if (url.pathname === '/api/categories') return jsonResponse(CATEGORIES);
    if (url.pathname === '/api/notes') {
      if (opts.notesFor) return jsonResponse(opts.notesFor(url));
      const category = url.searchParams.get('category');
      const tag = url.searchParams.get('tag');
      let items = ALL_NOTES;
      if (category !== null) items = items.filter((n) => n.categories.includes(category));
      if (tag !== null) items = items.filter((n) => n.tags.includes(tag));
      return jsonResponse({ total: items.length, items } satisfies NoteListResponse);
    }
    throw new Error(`unexpected fetch: ${url.pathname}`);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

// URL クエリを可視化するプローブ(選択状態の URL 反映を検証するため)。
function LocationProbe(): ReactElement {
  const [params] = useSearchParams();
  return (
    <div data-testid="probe">
      category={params.get('category') ?? 'none'};sort={params.get('sort') ?? 'none'};order=
      {params.get('order') ?? 'none'};tag={params.get('tag') ?? 'none'}
    </div>
  );
}

function renderPage(initialEntry = '/'): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const routes: RouteObject[] = [
    {
      path: '/',
      element: (
        <>
          <CategoryListPage />
          <LocationProbe />
        </>
      ),
    },
    { path: '/settings', element: <div>設定ページ</div> },
    { path: '/note/:id', element: <div>ノートページ</div> },
  ];
  const router = createMemoryRouter(routes, { initialEntries: [initialEntry] });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// --- CategoryTree: 件数バッジ -------------------------------------------

describe('CategoryTree — 件数バッジ', () => {
  it('各カテゴリと未分類のノート件数を表示する', async () => {
    installFetch();
    renderPage();

    const techBtn = await screen.findByRole('button', { name: /技術 のノート件数/ });
    expect(within(techBtn).getByText('1')).toBeDefined();

    const webBtn = screen.getByRole('button', { name: /Web のノート件数/ });
    expect(within(webBtn).getByText('2')).toBeDefined();

    const uncatBtn = screen.getByRole('button', { name: /未分類のノート件数/ });
    expect(within(uncatBtn).getByText('4')).toBeDefined();
  });
});

// --- CategoryTree: 選択状態の URL 反映 --------------------------------

describe('CategoryTree — 選択状態の URL 反映', () => {
  it('カテゴリをクリックすると ?category= が URL に入る', async () => {
    installFetch();
    renderPage();

    const webBtn = await screen.findByRole('button', { name: /Web のノート件数/ });
    fireEvent.click(webBtn);

    await waitFor(() =>
      expect(screen.getByTestId('probe').textContent).toContain('category=tech/web'),
    );
    expect(webBtn.getAttribute('aria-current')).toBe('true');
  });

  it('「すべて」で ?category= が消える / 未分類は _uncategorized', async () => {
    installFetch();
    renderPage('/?category=tech');

    const uncatBtn = await screen.findByRole('button', { name: /未分類のノート件数/ });
    fireEvent.click(uncatBtn);
    await waitFor(() =>
      expect(screen.getByTestId('probe').textContent).toContain('category=_uncategorized'),
    );

    fireEvent.click(screen.getByRole('button', { name: 'すべて' }));
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toContain('category=none'));
  });

  it('URL の ?category= を初期選択として反映する', async () => {
    installFetch();
    renderPage('/?category=life');

    const lifeBtn = await screen.findByRole('button', { name: /生活 のノート件数/ });
    expect(lifeBtn.getAttribute('aria-current')).toBe('true');
  });
});

// --- CategoryTree: 折りたたみ状態の localStorage 永続化 ---------------

describe('CategoryTree — 折りたたみ状態の localStorage 永続化', () => {
  it('折りたたむと localStorage["mnemo.tree.collapsed"] に経路が保存される', async () => {
    installFetch();
    renderPage();

    expect(await screen.findByRole('button', { name: /Web のノート件数/ })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: '技術 を折りたたむ' }));

    await waitFor(() => {
      const raw = window.localStorage.getItem('mnemo.tree.collapsed');
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw as string)).toEqual(['tech']);
    });
    expect(screen.queryByRole('button', { name: /Web のノート件数/ })).toBeNull();
  });

  it('localStorage に保存済みの折りたたみ状態を初期表示で復元する', async () => {
    window.localStorage.setItem('mnemo.tree.collapsed', JSON.stringify(['tech']));
    installFetch();
    renderPage();

    expect(await screen.findByRole('button', { name: /技術 のノート件数/ })).toBeDefined();
    expect(screen.queryByRole('button', { name: /Web のノート件数/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '技術 を展開' }));
    expect(await screen.findByRole('button', { name: /Web のノート件数/ })).toBeDefined();
  });

  it('壊れた localStorage 値でもクラッシュせず全展開で描画する', async () => {
    window.localStorage.setItem('mnemo.tree.collapsed', '{not json');
    installFetch();
    renderPage();
    expect(await screen.findByRole('button', { name: /Web のノート件数/ })).toBeDefined();
  });
});

// --- 空状態 + MCP スニペットリンク -----------------------------------

describe('CategoryListPage — 空状態', () => {
  it('ノート0件で空状態メッセージと設定(MCP スニペット)へのリンクを表示', async () => {
    installFetch({ notesFor: () => ({ total: 0, items: [] }) });
    renderPage();

    expect(await screen.findByText('まだノートがありません')).toBeDefined();
    const link = screen.getByRole('link', { name: /MCP 連携スニペット/ });
    expect(link.getAttribute('href')).toBe('/settings');
  });

  it('絞り込み結果が0件のときは絞り込み由来のメッセージを出す', async () => {
    installFetch({
      notesFor: (url) =>
        url.searchParams.get('category') === 'life'
          ? { total: 0, items: [] }
          : { total: ALL_NOTES.length, items: ALL_NOTES },
    });
    renderPage('/?category=life');

    expect(await screen.findByText(/このカテゴリ \/ タグに一致するノートはありません/)).toBeDefined();
    expect(screen.queryByText('まだノートがありません')).toBeNull();
  });
});

// --- NoteList: ソート切替が URL に反映 --------------------------------

describe('NoteList — ソート切替', () => {
  it('ソート種別と並び順の変更が URL クエリに反映される(既定 updated / desc)', async () => {
    installFetch();
    renderPage();

    const select = await screen.findByLabelText<HTMLSelectElement>('並び替え');
    expect(select.value).toBe('updated');

    fireEvent.change(select, { target: { value: 'title' } });
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toContain('sort=title'));

    // 並べ替え変更 = 新しい queryKey で一時的にスケルトン → 再描画を待つ
    const orderBtn = await screen.findByRole('button', { name: /降順|昇順/ });
    fireEvent.click(orderBtn);
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toContain('order=asc'));
  });
});

// --- エラー + 再試行 ---------------------------------------------------

describe('CategoryListPage — エラー', () => {
  it('/api/notes が失敗すると ErrorState と再試行ボタンを表示し、再試行で回復する', async () => {
    let ok = false;
    const fn = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.pathname === '/api/categories') return jsonResponse(CATEGORIES);
      if (!ok) return jsonResponse({ error: { code: 'BOOM', message: '一覧の取得に失敗' } }, 500);
      return jsonResponse({ total: ALL_NOTES.length, items: ALL_NOTES } satisfies NoteListResponse);
    });
    vi.stubGlobal('fetch', fn);

    renderPage();

    const retry = await screen.findByRole('button', { name: '再試行' });
    expect(screen.getByText('一覧の取得に失敗')).toBeDefined();

    ok = true;
    fireEvent.click(retry);

    await waitFor(() => expect(screen.getByLabelText('並び替え')).toBeDefined());
  });
});
