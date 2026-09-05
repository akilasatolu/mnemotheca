// test/web/search.test.tsx — SearchPage / SearchBox の単体テスト(設計 §13-15)。
//
// 実行環境: jsdom + @testing-library/react(vitest.config.ts の web プロジェクト)。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';

import SearchPage from '../../src/web/src/routes/SearchPage.js';
import { SearchBox } from '../../src/web/src/components/SearchBox.js';
import type { SearchResponse, SearchResult } from '../../src/web/src/api.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeResult(over: Partial<SearchResult>): SearchResult {
  return {
    id: 'n0',
    title: 'ノート',
    summary: '概要',
    categories: [],
    tags: [],
    score: 0,
    matchedFields: [],
    snippet: '',
    path: 'knowledge/n0.md',
    ...over,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// SearchBox(IME + デバウンス)
// ---------------------------------------------------------------------------

describe('SearchBox', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('通常入力はデバウンス 250ms 後に 1 回だけ onChange を発火する', () => {
    const onChange = vi.fn();
    render(<SearchBox value="" onChange={onChange} />);
    const input = screen.getByRole('searchbox');

    fireEvent.change(input, { target: { value: 'ne' } });
    act(() => vi.advanceTimersByTime(249));
    expect(onChange).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('ne');
  });

  it('連続入力はデバウンスでまとめられ、最後の値だけ発火する', () => {
    const onChange = vi.fn();
    render(<SearchBox value="" onChange={onChange} />);
    const input = screen.getByRole('searchbox');

    fireEvent.change(input, { target: { value: 'n' } });
    act(() => vi.advanceTimersByTime(100));
    fireEvent.change(input, { target: { value: 'ne' } });
    act(() => vi.advanceTimersByTime(100));
    expect(onChange).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(150));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith('ne');
  });

  it('IME 変換中は onChange で検索を発火せず、compositionend 後にデバウンス発火する', () => {
    const onChange = vi.fn();
    render(<SearchBox value="" onChange={onChange} />);
    const input = screen.getByRole('searchbox');

    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: 'にほんご' } });
    act(() => vi.advanceTimersByTime(300));
    expect(onChange).not.toHaveBeenCalled(); // 変換中は発火しない

    fireEvent.compositionEnd(input, { target: { value: 'にほんご' } });
    act(() => vi.advanceTimersByTime(249));
    expect(onChange).not.toHaveBeenCalled(); // まだデバウンス中

    act(() => vi.advanceTimersByTime(1));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('にほんご');
  });

  it('外部から value が変わると入力欄に反映される', () => {
    const onChange = vi.fn();
    const { rerender } = render(<SearchBox value="foo" onChange={onChange} />);
    expect(screen.getByRole('searchbox')).toHaveProperty('value', 'foo');

    rerender(<SearchBox value="bar" onChange={onChange} />);
    expect(screen.getByRole('searchbox')).toHaveProperty('value', 'bar');
  });
});

// ---------------------------------------------------------------------------
// SearchPage
// ---------------------------------------------------------------------------

describe('SearchPage', () => {
  function renderAt(initialEntry: string) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createMemoryRouter(
      [
        { path: '/', element: <div>カテゴリ一覧スタブ</div> },
        { path: '/search', element: <SearchPage /> },
        { path: '/note/:id', element: <div>ノートページスタブ</div> },
      ],
      { initialEntries: [initialEntry] },
    );
    const utils = render(
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    return { ...utils, router };
  }

  it('「意味検索ではない」旨の注記を常に表示する', async () => {
    vi.stubGlobal('fetch', vi.fn());
    renderAt('/search');
    expect(await screen.findByText(/意味の近さでは検索しません/)).toBeDefined();
  });

  it('2 文字未満は API を呼ばず「2 文字以上入力してください」を表示する', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    renderAt('/search?q=a');

    expect(await screen.findByText('2 文字以上入力してください')).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('サーバー 400 QUERY_TOO_SHORT でも同じメッセージを表示する', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: { code: 'QUERY_TOO_SHORT', message: 'too short' } }, 400)),
    );

    renderAt('/search?q=のは');

    expect(await screen.findByText('2 文字以上入力してください')).toBeDefined();
  });

  it('0 件のとき表記ゆれ案内とカテゴリ一覧(/)へのリンクを表示する', async () => {
    const body: SearchResponse = { query: 'zzz', took: 1, total: 0, results: [] };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(body)),
    );

    renderAt('/search?q=zzz');

    expect(await screen.findByText(/表記ゆれ/)).toBeDefined();
    const link = screen.getByRole('link', { name: /カテゴリ一覧/ });
    expect(link.getAttribute('href')).toBe('/');
  });

  it('結果はスコア降順で表示され、snippet の <mark> がそのまま描画される', async () => {
    const body: SearchResponse = {
      query: 'メモ',
      took: 3,
      total: 2,
      results: [
        makeResult({ id: 'n2', title: 'ノートその2', score: 0.4, snippet: '<mark>メモ</mark>2' }),
        makeResult({
          id: 'n1',
          title: 'ノートその1',
          score: 0.9,
          snippet: 'これは <mark>メモ</mark> です',
          matchedFields: ['title', 'content'],
        }),
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(body)),
    );

    const { container } = renderAt('/search?q=メモ');

    await screen.findByRole('link', { name: 'ノートその1' });
    const noteLinks = screen
      .getAllByRole('link')
      .filter((a) => (a.getAttribute('href') ?? '').startsWith('/note/'));
    expect(noteLinks.map((a) => a.textContent)).toEqual(['ノートその1', 'ノートその2']);
    expect(container.querySelector('mark')?.textContent).toBe('メモ');
  });

  it('結果クリックで /note/:id?q=<クエリ> へ遷移する', async () => {
    const body: SearchResponse = {
      query: 'メモ',
      took: 3,
      total: 1,
      results: [makeResult({ id: 'n1', title: 'ノートその1', score: 0.9, snippet: '<mark>メモ</mark>' })],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(body)),
    );

    const { router } = renderAt('/search?q=メモ');

    const link = await screen.findByRole('link', { name: 'ノートその1' });
    expect(link.getAttribute('href')).toBe('/note/n1?q=%E3%83%A1%E3%83%A2');

    fireEvent.click(link);

    expect(await screen.findByText('ノートページスタブ')).toBeDefined();
    expect(router.state.location.pathname).toBe('/note/n1');
    expect(router.state.location.search).toBe('?q=%E3%83%A1%E3%83%A2');
  });

  it('結果由来のフィルタでクライアント側絞り込みができる', async () => {
    const body: SearchResponse = {
      query: 'メモ',
      took: 3,
      total: 2,
      results: [
        makeResult({ id: 'n1', title: 'ノートその1', score: 0.9, categories: ['tech'], snippet: 'x' }),
        makeResult({ id: 'n2', title: 'ノートその2', score: 0.5, categories: ['life'], snippet: 'y' }),
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(body)),
    );

    renderAt('/search?q=メモ');

    await screen.findByRole('link', { name: 'ノートその1' });

    fireEvent.click(screen.getByRole('button', { name: 'life' }));

    expect(screen.queryByRole('link', { name: 'ノートその1' })).toBeNull();
    expect(screen.getByRole('link', { name: 'ノートその2' })).toBeDefined();
  });
});
