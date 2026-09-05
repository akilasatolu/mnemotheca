// test/web/note-view.test.tsx — NoteViewPage / MarkdownView の単体テスト(設計 §13-15)。
//
// 実行環境: jsdom + @testing-library/react(vitest.config.ts の web プロジェクト)。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';

import NoteViewPage from '../../src/web/src/routes/NoteViewPage.js';
import {
  resolveRelativePath,
  highlightQuery,
} from '../../src/web/src/components/MarkdownView.js';
import type { Heading, NoteListResponse, RenderedNote } from '../../src/web/src/api.js';

// --- fetch モック ----------------------------------------------------------

interface RouteState {
  rendered?: { status: number; body: unknown };
  notes?: NoteListResponse;
}

let routeState: RouteState;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/rendered')) {
        const r = routeState.rendered ?? { status: 500, body: {} };
        return jsonResponse(r.body, r.status);
      }
      if (url.startsWith('/api/notes')) {
        return jsonResponse(routeState.notes ?? { total: 0, items: [] });
      }
      return jsonResponse({ error: { code: 'X', message: 'unexpected' } }, 500);
    }),
  );
}

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([{ path: '/note/:id', element: <NoteViewPage /> }], {
    initialEntries: [path],
  });
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const HEADINGS: Heading[] = [
  { depth: 1, text: 'はじめに', slug: 'intro' },
  { depth: 2, text: '詳細セクション', slug: 'details' },
];

const RENDERED_OK: RenderedNote = {
  id: 'n-1',
  html:
    '<h1 id="intro">はじめに</h1><p>これは alpha という語を含む本文です。alpha は二回出ます。</p>' +
    '<h2 id="details">詳細セクション</h2><p>ここでは <a href="./sibling.md">兄弟ノート</a> と ' +
    '<a href="https://example.com/x.md">外部</a> と <a href="#intro">冒頭</a> を参照します。</p>' +
    '<p>既存の <mark>alpha</mark> はそのまま。</p>',
  frontmatter: {
    title: 'テストノート',
    categories: ['tech/web'],
    tags: ['vitest', 'react'],
    created: '2026-08-01T10:00:00+09:00',
    updated: '2026-09-01T12:00:00+09:00',
  },
  headings: HEADINGS,
  path: 'knowledge/tech/web/test-note.md',
};

const NOTES: NoteListResponse = {
  total: 2,
  items: [
    {
      id: 'n-1',
      title: 'テストノート',
      summary: '',
      categories: ['tech/web'],
      tags: ['vitest', 'react'],
      created: '2026-08-01T10:00:00+09:00',
      updated: '2026-09-01T12:00:00+09:00',
      path: 'knowledge/tech/web/test-note.md',
    },
    {
      id: 'n-2',
      title: '兄弟ノート',
      summary: '',
      categories: ['tech/web'],
      tags: [],
      created: '2026-08-02T10:00:00+09:00',
      updated: '2026-08-02T10:00:00+09:00',
      path: 'knowledge/tech/web/sibling.md',
    },
  ],
};

beforeEach(() => {
  routeState = {};
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// --- resolveRelativePath(純関数) ----------------------------------------

describe('resolveRelativePath', () => {
  const cur = 'knowledge/tech/web/test-note.md';

  it('同ディレクトリの ./x.md を vault 相対パスへ解決する', () => {
    expect(resolveRelativePath('./sibling.md', cur)).toBe('knowledge/tech/web/sibling.md');
  });

  it('親ディレクトリ ../ を辿って解決する', () => {
    expect(resolveRelativePath('../cli/setup.md', cur)).toBe('knowledge/tech/cli/setup.md');
  });

  it('拡張子なし・スキーム付き・ルート絶対・アンカーのみは null', () => {
    expect(resolveRelativePath('https://example.com/x.md', cur)).toBeNull();
    expect(resolveRelativePath('obsidian://open?path=y', cur)).toBeNull();
    expect(resolveRelativePath('/knowledge/x.md', cur)).toBeNull();
    expect(resolveRelativePath('#intro', cur)).toBeNull();
    expect(resolveRelativePath('./other', cur)).toBeNull();
  });

  it('?query や #hash を除去してから解決する', () => {
    expect(resolveRelativePath('./sibling.md#section', cur)).toBe('knowledge/tech/web/sibling.md');
  });
});

// --- highlightQuery(純関数) -------------------------------------------

describe('highlightQuery', () => {
  it('テキストノードの一致箇所のみ <mark class="q-hl"> で包み、既存 <mark> は触らない', () => {
    const root = document.createElement('div');
    root.innerHTML = '<p>alpha beta alpha</p><p>既存 <mark>alpha</mark></p>';
    highlightQuery(root, 'alpha');

    const hls = root.querySelectorAll('mark.q-hl');
    expect(hls).toHaveLength(2);
    // 既存 <mark> は 1 個のまま(q-hl クラスは付かない)。
    const plainMarks = Array.from(root.querySelectorAll('mark')).filter((m) => !m.classList.contains('q-hl'));
    expect(plainMarks).toHaveLength(1);
    expect(plainMarks[0]?.textContent).toBe('alpha');
  });

  it('空クエリでは何もしない', () => {
    const root = document.createElement('div');
    root.innerHTML = '<p>alpha</p>';
    highlightQuery(root, '   ');
    expect(root.querySelectorAll('mark.q-hl')).toHaveLength(0);
  });
});

// --- NoteViewPage: 正常系 + TOC ----------------------------------------

describe('NoteViewPage', () => {
  it('title / categories / tags / 日付 と MarkdownView を表示し、TOC が headings と一致する', async () => {
    routeState = { rendered: { status: 200, body: RENDERED_OK }, notes: NOTES };
    renderAt('/note/n-1');

    expect(await screen.findByRole('heading', { level: 1, name: 'テストノート' })).toBeDefined();
    expect(screen.getByLabelText('カテゴリ').textContent).toContain('tech/web');
    expect(screen.getByLabelText('タグ').textContent).toContain('vitest');

    const toc = await screen.findByRole('navigation', { name: '目次' });
    const tocLinks = toc.querySelectorAll('a');
    expect(Array.from(tocLinks).map((a) => a.textContent)).toEqual(
      HEADINGS.map((h) => h.text),
    );
    expect(Array.from(tocLinks).map((a) => a.getAttribute('href'))).toEqual(
      HEADINGS.map((h) => `#${h.slug}`),
    );
  });

  it('rendered レスポンスの path を使い、ページ読み込み時に一覧 fetch を発行しない', async () => {
    routeState = { rendered: { status: 200, body: RENDERED_OK }, notes: NOTES };
    renderAt('/note/n-1');

    await screen.findByRole('heading', { level: 1, name: 'テストノート' });
    // 「元ファイルのパスをコピー」は rendered.path から直接有効化される(一覧引き不要)。
    const copyBtn = screen.getByRole('button', {
      name: '元ファイルのパスをコピー',
    }) as HTMLButtonElement;
    expect(copyBtn.disabled).toBe(false);

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const listCalls = fetchMock.mock.calls.filter((c) => {
      const u = typeof c[0] === 'string' ? c[0] : String(c[0]);
      return u.startsWith('/api/notes') && !u.includes('/rendered');
    });
    expect(listCalls).toHaveLength(0);
  });

  it('?q= があると本文の該当語を <mark class="q-hl"> でハイライトする(既存 <mark> は保持)', async () => {
    routeState = { rendered: { status: 200, body: RENDERED_OK }, notes: NOTES };
    const { container } = renderAt('/note/n-1?q=alpha');

    await screen.findByRole('heading', { level: 1, name: 'テストノート' });

    await waitFor(() => {
      expect(container.querySelectorAll('mark.q-hl').length).toBeGreaterThanOrEqual(2);
    });
    const plainMarks = Array.from(container.querySelectorAll('.markdown-body mark')).filter(
      (m) => !m.classList.contains('q-hl'),
    );
    expect(plainMarks).toHaveLength(1);
  });

  it('404 のとき「見つかりません」と一覧へのリンクを表示する', async () => {
    routeState = {
      rendered: { status: 404, body: { error: { code: 'NOT_FOUND', message: '該当するノートがありません。' } } },
    };
    renderAt('/note/missing');

    expect(await screen.findByText(/このノートは見つかりません/)).toBeDefined();
    const link = screen.getByRole('link', { name: '一覧へ戻る' });
    expect(link.getAttribute('href')).toBe('/');
  });

  it('422(壊れ frontmatter)のとき raw 抜粋とエラーメッセージを表示する', async () => {
    routeState = {
      rendered: {
        status: 422,
        body: {
          error: {
            code: 'FRONTMATTER_PARSE',
            message: 'このノートの frontmatter を解析できません。',
            details: {
              rawExcerpt: '---\nid: n-broken\ntitle: [壊れ\n---\n本文',
              message: 'YAMLParseError: unexpected token',
              path: 'knowledge/tech/web/broken.md',
            },
          },
        },
      },
    };
    renderAt('/note/n-broken');

    expect(await screen.findByText('frontmatter を解析できません')).toBeDefined();
    expect(screen.getByLabelText('raw frontmatter 抜粋').textContent).toContain('id: n-broken');
    expect(screen.getByText(/YAMLParseError/)).toBeDefined();
    expect(screen.getByText('knowledge/tech/web/broken.md')).toBeDefined();
  });

  it('本文の相対 .md リンクをクリックすると解決先ノートへ SPA 遷移する', async () => {
    routeState = { rendered: { status: 200, body: RENDERED_OK }, notes: NOTES };
    const { container } = renderAt('/note/n-1');
    await screen.findByRole('heading', { level: 1, name: 'テストノート' });
    // filePath(notePath)が確定してリンク横取りの effect が張り直されるのを待つ。
    await waitFor(() => {
      const btn = screen.getByRole('button', {
        name: '元ファイルのパスをコピー',
      }) as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
    });

    const relLink = Array.from(container.querySelectorAll('.markdown-body a')).find(
      (a) => a.getAttribute('href') === './sibling.md',
    ) as HTMLAnchorElement;
    expect(relLink).toBeDefined();

    // 遷移先(n-2)の rendered を用意。
    routeState.rendered = {
      status: 200,
      body: { ...RENDERED_OK, id: 'n-2', frontmatter: { ...RENDERED_OK.frontmatter, title: '兄弟ノート' } },
    };
    relLink.click();

    expect(await screen.findByRole('heading', { level: 1, name: '兄弟ノート' })).toBeDefined();
  });

  it('「元ファイルのパスをコピー」で navigator.clipboard.writeText を呼ぶ', async () => {
    routeState = { rendered: { status: 200, body: RENDERED_OK }, notes: NOTES };
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });

    renderAt('/note/n-1');
    const btn = await screen.findByRole('button', { name: '元ファイルのパスをコピー' });
    btn.click();
    expect(writeText).toHaveBeenCalledWith('knowledge/tech/web/test-note.md');
  });
});
