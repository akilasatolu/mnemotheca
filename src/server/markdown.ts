// src/server/markdown.ts — ノート本文 Markdown を安全な HTML にレンダリングする(設計書 §11-6 / §13-13b)。
//
// パイプライン:
//   1. markdown-it({ html:false, linkify:true, typographer:false })
//      + markdown-it-anchor(見出し id)/ markdown-it-footnote(脚注)/ markdown-it-task-lists(チェックボックス)
//   2. markdown-it の `highlight` オプションで Shiki(単一テーマ `github-light` 固定)。
//      Shiki は非同期初期化のため、モジュールロード時に highlighter を 1 回だけ生成してキャッシュする。
//      初期化に失敗した場合・未知の言語の場合はハイライトなしの素の <pre><code> にフォールバックする。
//   3. 生成 HTML を sanitize-html(§11-6 の確定許可リスト SANITIZE_OPTIONS)に通す。
//
// `render(md)` は `{ html, headings }` を返す。`headings[].slug` は markdown-it-anchor が
// 付与する見出し `id` と完全一致する(同じ `slugify` を使用)。
//
// 付録 C V-7(Shiki 4 非同期初期化コスト): ローカル計測(Node 20 / macOS)では
// createHighlighter(github-light + COMMON_LANGS 25 言語)の初回コストは約 130ms。
// 初回 render 時に一度だけ支払い、以降の render は同期的な highlighter.codeToHtml を
// 使うため追加コストは無い。

import MarkdownIt, { type MarkdownIt as MarkdownItInstance } from 'markdown-it';
import anchor from 'markdown-it-anchor';
import footnote from 'markdown-it-footnote';
// markdown-it-task-lists は型定義を同梱していない(@types も無い)。
// @ts-expect-error - no type declarations for 'markdown-it-task-lists'
import taskLists from 'markdown-it-task-lists';
import sanitizeHtml from 'sanitize-html';
import { createHighlighter, type Highlighter } from 'shiki';

/** 見出し 1 件分。`slug` は markdown-it-anchor が付与する `id` と一致する。 */
export interface Heading {
  depth: number;
  text: string;
  slug: string;
}

/** `render()` の戻り値。 */
export interface RenderResult {
  html: string;
  headings: Heading[];
}

/** Shiki 固定テーマ(設計 §11-6: 単一テーマ github-light 固定)。 */
const SHIKI_THEME = 'github-light';

/**
 * Shiki にプリロードする言語。ここに無い言語のコードブロックはハイライトなしの
 * <pre><code> にフォールバックする(描画は崩れない)。
 */
const COMMON_LANGS = [
  'text',
  'bash',
  'shell',
  'json',
  'jsonc',
  'yaml',
  'toml',
  'ini',
  'markdown',
  'html',
  'xml',
  'css',
  'javascript',
  'typescript',
  'jsx',
  'tsx',
  'python',
  'go',
  'rust',
  'java',
  'c',
  'cpp',
  'sql',
  'diff',
  'dockerfile',
];

/**
 * 見出し slug 生成(設計 §11-6: NFKC → 小文字 → 非英数字を `-` → 前後 `-` 除去)。
 * markdown-it-anchor の `slugify` にも渡し、`headings[].slug` と見出し `id` を一致させる。
 */
export function slugify(str: string): string {
  const base = str
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base === '' ? 'section' : base;
}

/**
 * §11-6 で確定した sanitize-html 許可リスト(確定値。足さない・削らない)。
 * Shiki のインライン色(pre/code/span の style・class)を通しつつ、危険な style / タグ /
 * スキームを落とす。
 */
export const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'p',
    'br',
    'hr',
    'blockquote',
    'pre',
    'code',
    'span',
    'em',
    'strong',
    'del',
    's',
    'sub',
    'sup',
    'mark',
    'ul',
    'ol',
    'li',
    'a',
    'img',
    'table',
    'thead',
    'tbody',
    'tfoot',
    'tr',
    'th',
    'td',
    'section', // markdown-it-footnote は <section class="footnotes"> を出す(div ではない)
    'input', // タスクリストの [ ] チェックボックスのみ(disabled)
  ],
  disallowedTagsMode: 'discard',
  allowedAttributes: {
    a: ['href', 'title', 'target', 'rel', 'class', 'id'], // class: footnote-ref / footnote-backref、id: fnref1 等
    img: ['src', 'alt', 'title', 'width', 'height'],
    span: ['class', 'style'], // Shiki のトークン色
    code: ['class', 'style'], // language-xxx クラス / Shiki
    pre: ['class', 'style'], // shiki クラス / background-color
    section: ['class'], // footnotes
    ul: ['class'],
    ol: ['class'],
    li: ['class', 'id'], // contains-task-list / footnotes-list / footnote-item / task-list-item、id: fn1 等
    input: ['type', 'checked', 'disabled', 'class'], // markdown-it-task-lists の checkbox
    hr: ['class'], // footnotes-sep
    h1: ['id'],
    h2: ['id'],
    h3: ['id'],
    h4: ['id'],
    h5: ['id'],
    h6: ['id'], // TOC アンカー
    td: ['align'],
    th: ['align'],
    '*': [],
  },
  allowedStyles: {
    '*': {
      // Shiki が出す色系のみ許可。値は 16進 / rgb() / 英名に限定
      color: [/^#(0x)?[0-9a-f]{3,8}$/i, /^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/, /^[a-z-]+$/],
      'background-color': [
        /^#(0x)?[0-9a-f]{3,8}$/i,
        /^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/,
        /^[a-z-]+$/,
      ],
      'font-style': [/^(italic|normal)$/],
      'font-weight': [/^(bold|normal|[1-9]00)$/],
      'text-decoration': [/^(underline|line-through|none)$/],
    },
  },
  allowedClasses: {
    pre: ['shiki', 'shiki-*'],
    code: ['language-*', 'hljs'],
    span: ['line', 'shiki-*'],
    section: ['footnotes'],
    ul: ['contains-task-list'],
    ol: ['footnotes-list'],
    li: ['task-list-item', 'footnote-item'],
    hr: ['footnotes-sep'],
    a: ['footnote-ref', 'footnote-backref'],
    input: ['task-list-item-checkbox'],
  },
  allowedSchemes: ['http', 'https', 'mailto'], // a[href] のスキーム
  allowedSchemesByTag: { img: ['http', 'https', 'data'] }, // 画像は http(s) と data:(小さいインライン画像)のみ
  allowProtocolRelative: false,
  transformTags: {
    a: (tagName, attribs) => {
      const href = attribs.href ?? '';
      const external = /^https?:\/\//i.test(href);
      return {
        tagName,
        attribs: {
          ...attribs,
          ...(external ? { target: '_blank', rel: 'noopener noreferrer nofollow' } : {}),
        },
      };
    },
  },
};

/**
 * Shiki highlighter のシングルトン Promise。初期化失敗時は `null` に解決する
 * (以降フォールバック描画)。モジュールロード時ではなく初回 render 時に生成する。
 */
let highlighterPromise: Promise<Highlighter | null> | null = null;

function getHighlighter(): Promise<Highlighter | null> {
  if (highlighterPromise === null) {
    const startedAt = Date.now();
    highlighterPromise = createHighlighter({
      themes: [SHIKI_THEME],
      langs: COMMON_LANGS,
    })
      .then((h) => {
        // 付録 C V-7: 初期化コストの計測ポイント。
        const elapsed = Date.now() - startedAt;
        if (elapsed > 1000) {
          console.error(`[mnemo] Shiki highlighter init took ${elapsed}ms`);
        }
        return h;
      })
      .catch((err: unknown) => {
        console.error('[mnemo] Shiki highlighter init failed; code blocks will not be highlighted', err);
        return null;
      });
  }
  return highlighterPromise;
}

/** テスト用: highlighter キャッシュを破棄する(本番コードからは呼ばない)。 */
export function __resetHighlighterCache(): void {
  highlighterPromise = null;
}

function buildMarkdownIt(highlighter: Highlighter | null, headings: Heading[]): MarkdownItInstance {
  const md: MarkdownItInstance = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: false,
    highlight: (code, lang) => {
      if (highlighter === null) return ''; // フォールバック: markdown-it 既定の <pre><code>
      const language = lang && highlighter.getLoadedLanguages().includes(lang) ? lang : null;
      if (language === null) return '';
      try {
        return highlighter.codeToHtml(code, { lang: language, theme: SHIKI_THEME });
      } catch {
        return '';
      }
    },
  });

  md.use(anchor, {
    level: [1, 2, 3, 4, 5, 6],
    slugify,
    tabIndex: false,
    callback: (token: { tag: string }, info: { slug: string; title: string }) => {
      headings.push({
        depth: Number(token.tag.slice(1)),
        text: info.title,
        slug: info.slug,
      });
    },
  });
  md.use(footnote);
  md.use(taskLists);

  return md;
}

/**
 * Markdown 文字列を安全な HTML にレンダリングする(設計 §11-6)。
 *
 * @param markdown ノート本文(フロントマター除去済みを想定)
 * @returns `{ html, headings }`。`headings[].slug` は HTML 内の見出し `id` と一致する。
 */
export async function render(markdown: string): Promise<RenderResult> {
  const highlighter = await getHighlighter();
  const headings: Heading[] = [];
  const md = buildMarkdownIt(highlighter, headings);
  const rawHtml = md.render(markdown);
  const html = sanitizeHtml(rawHtml, SANITIZE_OPTIONS);
  return { html, headings };
}
