// src/web/src/components/MarkdownView.tsx — レンダリング済み HTML の埋め込み表示(設計 §11-4 / §11-6)。
//
// 責務:
//   - サーバーで sanitize 済みの HTML を `dangerouslySetInnerHTML` で埋め込む
//     (**クライアントで再サニタイズしない**。設計 §11-6「sanitize はサーバー責務」)。
//   - `headings`(rendered レスポンス)から TOC を生成し、スクロールスパイで現在位置を強調。
//   - `query`(`?q=`)があれば本文テキストノードを走査して `<mark class="q-hl">` で強調。
//   - 本文中の相対 `.md` リンクのクリックを横取りし、同ディレクトリ基準でノートを解決 → SPA 遷移。
//     外部リンク(`http(s)://`)・`#` アンカー・`obsidian://` はそのまま素通し。
//
// 規約: React 19 / strict / verbatimModuleSyntax。スタイルは touches の制約上ここではインライン。

import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactElement } from 'react';
import type { Heading } from '../api.js';

export interface MarkdownViewProps {
  /** サーバーで sanitize 済みの HTML。 */
  html: string;
  /** rendered レスポンスの `headings`(`{ depth, text, slug }`)。 */
  headings: Heading[];
  /** 現在のノートの vault 相対パス(`knowledge/<...>/<slug>.md`)。相対リンク解決の基準。 */
  notePath: string;
  /** `?q=` の検索語。あれば本文中の該当語を `<mark class="q-hl">` で強調。 */
  query?: string;
  /**
   * 相対 `.md` リンクの解決関数。解決先ノート id を返せば SPA 遷移、
   * `null` なら何もしない(既定リンク動作も抑止)。
   */
  resolveMdLink: (targetPath: string) => string | null;
  /** ノート id への SPA 遷移。 */
  onNavigateToNote: (id: string) => void;
}

/**
 * 相対 `.md` リンク href を、現在ノートのパスを基準に vault 相対パスへ解決する純関数。
 * - `href` が `.md` で終わらない / スキーム付き / ルート絶対(`/`)/ アンカーのみ → `null`
 * - `?`・`#` 以降は除去してから解決
 * - `.` / `..` / 余分な `/` を正規化
 */
export function resolveRelativePath(href: string, currentNotePath: string): string | null {
  if (href === '') return null;
  const cut = href.search(/[?#]/);
  const pathPart = cut === -1 ? href : href.slice(0, cut);
  if (pathPart === '' || !pathPart.toLowerCase().endsWith('.md')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(pathPart)) return null; // http:, obsidian:, mailto: 等
  if (pathPart.startsWith('/')) return null; // ルート絶対はノート相対解決の対象外

  const lastSlash = currentNotePath.lastIndexOf('/');
  const segments = lastSlash === -1 ? [] : currentNotePath.slice(0, lastSlash).split('/').filter((s) => s !== '');
  for (const seg of pathPart.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (segments.length > 0) segments.pop();
      continue;
    }
    segments.push(seg);
  }
  return segments.join('/');
}

/** サニタイズ済み HTML のテキストノードを走査し、`query` 一致箇所を `<mark class="q-hl">` で包む。 */
export function highlightQuery(root: HTMLElement, query: string): void {
  const q = query.trim();
  if (q === '') return;
  const ql = q.toLowerCase();

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node): number {
      const parent = node.parentElement;
      if (parent === null) return NodeFilter.FILTER_REJECT;
      // 既存 <mark>(サーバー snippet 等)・スクリプト/スタイル内は対象外。
      if (parent.closest('mark, script, style') !== null) return NodeFilter.FILTER_REJECT;
      const value = node.nodeValue ?? '';
      return value.toLowerCase().includes(ql) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  const targets: Text[] = [];
  while (walker.nextNode() !== null) targets.push(walker.currentNode as Text);

  for (const textNode of targets) {
    const text = textNode.nodeValue ?? '';
    const lower = text.toLowerCase();
    const frag = document.createDocumentFragment();
    let from = 0;
    let idx = lower.indexOf(ql);
    while (idx !== -1) {
      if (idx > from) frag.appendChild(document.createTextNode(text.slice(from, idx)));
      const mark = document.createElement('mark');
      mark.className = 'q-hl';
      mark.textContent = text.slice(idx, idx + q.length);
      frag.appendChild(mark);
      from = idx + q.length;
      idx = lower.indexOf(ql, from);
    }
    if (from < text.length) frag.appendChild(document.createTextNode(text.slice(from)));
    textNode.parentNode?.replaceChild(frag, textNode);
  }
}

export function MarkdownView({
  html,
  headings,
  notePath,
  query,
  resolveMdLink,
  onNavigateToNote,
}: MarkdownViewProps): ReactElement {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [activeSlug, setActiveSlug] = useState<string | null>(headings[0]?.slug ?? null);

  const toc = useMemo(() => headings.filter((h) => h.slug !== ''), [headings]);

  // `?q=` ハイライト: HTML 差し替え後に DOM を走査。
  useEffect(() => {
    const el = bodyRef.current;
    if (el === null) return;
    if (query !== undefined && query.trim() !== '') highlightQuery(el, query);
  }, [html, query]);

  // 相対 `.md` リンクのクリック横取り。
  useEffect(() => {
    const el = bodyRef.current;
    if (el === null) return;
    const onClick = (ev: MouseEvent): void => {
      const anchor = (ev.target as HTMLElement | null)?.closest('a');
      if (anchor === null || anchor === undefined) return;
      const href = anchor.getAttribute('href') ?? '';
      const targetPath = resolveRelativePath(href, notePath);
      if (targetPath === null) return; // 外部 / アンカー / obsidian:// はそのまま
      ev.preventDefault();
      const noteId = resolveMdLink(targetPath);
      if (noteId !== null) onNavigateToNote(noteId);
    };
    el.addEventListener('click', onClick);
    return () => el.removeEventListener('click', onClick);
  }, [notePath, resolveMdLink, onNavigateToNote]);

  // スクロールスパイ(IntersectionObserver が使える環境のみ)。
  useEffect(() => {
    const el = bodyRef.current;
    if (el === null || toc.length === 0) return;
    if (typeof IntersectionObserver === 'undefined') return;

    const observed: Element[] = [];
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const first = visible[0]?.target.id;
        if (first !== undefined && first !== '') setActiveSlug(first);
      },
      { rootMargin: '0px 0px -70% 0px' },
    );
    for (const h of toc) {
      const node = el.querySelector(`#${CSS.escape(h.slug)}`);
      if (node !== null) {
        observer.observe(node);
        observed.push(node);
      }
    }
    return () => observer.disconnect();
  }, [toc, html]);

  const onTocClick = (slug: string) => (ev: ReactMouseEvent): void => {
    const el = bodyRef.current;
    const node = el?.querySelector(`#${CSS.escape(slug)}`);
    if (node !== undefined && node !== null) {
      ev.preventDefault();
      node.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setActiveSlug(slug);
    }
  };

  return (
    <div style={{ display: 'flex', gap: '2rem', alignItems: 'flex-start' }}>
      <article
        ref={bodyRef}
        className="markdown-body"
        style={{ flex: 1, minWidth: 0 }}
        // サーバーで sanitize 済み。クライアントで再サニタイズしない(設計 §11-6)。
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {toc.length > 0 ? (
        <nav aria-label="目次" style={{ flex: '0 0 14rem', position: 'sticky', top: '1rem', fontSize: '0.85rem' }}>
          <p style={{ fontWeight: 'bold', margin: '0 0 0.5rem' }}>目次</p>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {toc.map((h) => (
              <li key={h.slug} style={{ paddingLeft: `${(Math.max(1, h.depth) - 1) * 0.75}rem` }}>
                <a
                  href={`#${h.slug}`}
                  aria-current={activeSlug === h.slug ? 'location' : undefined}
                  data-active={activeSlug === h.slug ? 'true' : undefined}
                  onClick={onTocClick(h.slug)}
                  style={{ fontWeight: activeSlug === h.slug ? 'bold' : 'normal' }}
                >
                  {h.text}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
    </div>
  );
}

export default MarkdownView;
