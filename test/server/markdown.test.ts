import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetHighlighterCache,
  render,
  SANITIZE_OPTIONS,
  slugify,
} from '../../src/server/markdown.js';

// 設計 §11-6 / §13-13b。実際の Markdown 文字列を render して HTML を検証する。

describe('slugify (§11-6: NFKC → 小文字 → 非英数字を "-" → 前後 "-" 除去)', () => {
  it('英字見出しをそのまま slug 化する', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });

  it('全角・記号を NFKC + ハイフン圧縮する', () => {
    expect(slugify('ＡＷＳ  上での  MCP!!!')).toBe('aws-mcp');
  });

  it('英数字が無い見出しは "section" にフォールバックする', () => {
    expect(slugify('機械学習')).toBe('section');
  });
});

describe('render — Shiki 色の残存とサニタイズ (§13-13b)', () => {
  beforeEach(() => {
    __resetHighlighterCache();
  });

  it('コードブロックの Shiki インライン色が sanitize 後も残る', async () => {
    const { html } = await render('```javascript\nconst x = 1;\n```\n');
    // pre に背景色、span にトークン色が残る(許可リストが効いている)
    expect(html).toMatch(/<pre[^>]*style="[^"]*background-color:#[0-9a-fA-F]{3,8}/);
    expect(html).toMatch(/<span style="color:#[0-9a-fA-F]{3,8}/);
    expect(html).toContain('class="shiki"');
  });

  it('色以外の危険な style は SANITIZE_OPTIONS で落ちる(color/background-color のみ許可)', () => {
    const sanitizeHtml = SANITIZE_OPTIONS;
    // SANITIZE_OPTIONS を直接使って危険な style が除去されることを確認する。
    // (markdown-it は html:false なので生 style を通さないため、許可リスト自体を検証する)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return import('sanitize-html').then(({ default: sh }) => {
      const dirty =
        '<span style="color:#ff0000;position:absolute;background:url(http://evil/x)">x</span>';
      const clean = sh(dirty, sanitizeHtml);
      expect(clean).toContain('color:#ff0000');
      expect(clean).not.toContain('position');
      expect(clean).not.toContain('url(');
    });
  });

  it('未知の言語はハイライトなしの <pre><code> にフォールバックする', async () => {
    const { html } = await render('```this-lang-does-not-exist\nplain body\n```\n');
    expect(html).toContain('<pre><code');
    expect(html).toContain('plain body');
    expect(html).not.toContain('style="color:#');
  });
});

describe('render — XSS 除去 (§13-13b)', () => {
  beforeEach(() => {
    __resetHighlighterCache();
  });

  it('<script> はタグとして現れない', async () => {
    const { html } = await render('hello <script>alert(1)</script> world\n');
    expect(html).not.toContain('<script');
    expect(html).toContain('hello');
  });

  it('<img onerror=...> の onerror 属性が除去される', async () => {
    const { html } = await render('![x](http://example.com/a.png "t") <img src=x onerror=alert(1)>\n');
    // 生 HTML の <img onerror> はタグとして現れない(html:false でエスケープ)。許可された画像は残る。
    expect(html).not.toMatch(/<img[^>]*onerror/i);
    expect(html).toContain('src="http://example.com/a.png"');
  });

  it('javascript: スキームのリンクは href として現れない', async () => {
    const { html } = await render('[click](javascript:alert(1))\n');
    expect(html).not.toMatch(/href\s*=\s*["']?\s*javascript:/i);
  });

  it('<iframe> は除去される', async () => {
    const { html } = await render('text <iframe src="http://evil"></iframe> more\n');
    expect(html).not.toContain('<iframe');
  });
});

describe('render — リンクのスキームと属性 (§13-13b)', () => {
  beforeEach(() => {
    __resetHighlighterCache();
  });

  it('未許可スキーム(obsidian://)のリンクは href が除去される', async () => {
    const { html } = await render('[開く](obsidian://open?vault=v&file=x)\n');
    expect(html).not.toContain('obsidian://');
    expect(html).toContain('開く');
  });

  it('外部 https リンクには target=_blank と rel が付く', async () => {
    const { html } = await render('[site](https://example.com/page)\n');
    expect(html).toContain('href="https://example.com/page"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  it('相対リンクはそのまま(target なし)', async () => {
    const { html } = await render('[other](./other-note.md)\n');
    expect(html).toContain('href="./other-note.md"');
    expect(html).not.toContain('target=');
  });
});

describe('render — タスクリスト (§13-13b)', () => {
  beforeEach(() => {
    __resetHighlighterCache();
  });

  it('未チェック項目は disabled な checkbox になる', async () => {
    const { html } = await render('- [ ] todo item\n');
    expect(html).toMatch(/<input[^>]*type="checkbox"/);
    expect(html).toContain('disabled');
    expect(html).not.toMatch(/<input[^>]*\bchecked\b/);
    expect(html).toContain('contains-task-list');
  });

  it('チェック済み項目は checked かつ disabled を保持する', async () => {
    const { html } = await render('- [x] done item\n');
    expect(html).toMatch(/<input[^>]*checked/);
    expect(html).toMatch(/<input[^>]*disabled/);
  });
});

describe('render — 脚注 (§13-13b)', () => {
  beforeEach(() => {
    __resetHighlighterCache();
  });

  it('<section class="footnotes"> が div 化されず残る', async () => {
    const { html } = await render('本文[^1]\n\n[^1]: 脚注本文\n');
    expect(html).toContain('<section class="footnotes"');
    expect(html).toContain('脚注本文');
  });
});

describe('render — 見出し id と headings[].slug の一致 (§13-13b)', () => {
  beforeEach(() => {
    __resetHighlighterCache();
  });

  it('headings[] の depth/text/slug を返し、slug が HTML の見出し id と一致する', async () => {
    const { html, headings } = await render('# Intro\n\n## Getting Started\n\n### 詳細な説明\n');
    expect(headings).toEqual([
      { depth: 1, text: 'Intro', slug: 'intro' },
      { depth: 2, text: 'Getting Started', slug: 'getting-started' },
      { depth: 3, text: '詳細な説明', slug: 'section' },
    ]);
    for (const h of headings) {
      expect(html).toContain(`id="${h.slug}"`);
    }
  });

  it('同名見出しは anchor の一意化サフィックスが slug と id の両方に反映される', async () => {
    const { html, headings } = await render('## Dup\n\n## Dup\n');
    expect(headings.map((h) => h.slug)).toEqual(['dup', 'dup-1']);
    expect(html).toContain('id="dup"');
    expect(html).toContain('id="dup-1"');
  });
});

describe('render — 画像スキーム (§13-13b)', () => {
  beforeEach(() => {
    __resetHighlighterCache();
  });

  it('http と data: の画像は src が残る', async () => {
    const { html } = await render(
      '![a](http://x/y.png)\n\n![b](data:image/png;base64,iVBORw0KGgo=)\n',
    );
    expect(html).toContain('src="http://x/y.png"');
    expect(html).toContain('src="data:image/png;base64,iVBORw0KGgo="');
  });

  it('相対パス画像は src が残る(実配信は無いので UI 上は壊れ画像 = 既知の制限)', async () => {
    const { html } = await render('![c](attachments/x.png)\n');
    expect(html).toContain('src="attachments/x.png"');
  });
});

describe('render — Shiki 初期化失敗時のフォールバック (§13-13b / 付録 C V-7)', () => {
  it('createHighlighter が reject してもレンダリングは成功し、素の <pre><code> を返す', async () => {
    vi.resetModules();
    vi.doMock('shiki', () => ({
      createHighlighter: () => Promise.reject(new Error('boom')),
    }));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const mod = await import('../../src/server/markdown.js');
      const { html } = await mod.render('```javascript\nconst x = 1;\n```\n');
      expect(html).toContain('<pre><code');
      expect(html).toContain('const x = 1;');
      expect(html).not.toContain('style="color:#');
    } finally {
      errSpy.mockRestore();
      vi.doUnmock('shiki');
      vi.resetModules();
    }
  });
});
