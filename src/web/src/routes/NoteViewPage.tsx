// src/web/src/routes/NoteViewPage.tsx — Markdown 閲覧画面(設計 §11-4 / §11-6)。
//
// main.tsx はこのファイルの **default export** をルート要素に結線している(コンポーネント名維持)。
//
// - `/api/notes/:id/rendered`(`useRenderedNote`)を `MarkdownView` に渡し、サーバー sanitize 済み
//   HTML をそのまま埋め込む(クライアント再サニタイズなし)。
// - 上部: title / categories バッジ(`CategoryBadge`)/ tags(`TagChip` → `/?tag=<tag>`)/ created・updated。
// - TOC + スクロールスパイ、`?q=` ハイライトは `MarkdownView` が担当。
// - アクション: 「元ファイルのパスをコピー」(`navigator.clipboard`)、「Obsidian で開く」(`obsidian://`)。
//   元ファイルパスは rendered レスポンスの `path`(vault 相対)を直接使う(一覧を逆引きしない)。
// - 相対 `.md` リンクは `MarkdownView` がクリック横取り → ここで解決先ノートを引いて SPA 遷移。
//   一覧はページ読み込み時には取得せず、相対リンクがクリックされたときだけ遅延取得する。
// - 404 → 「見つかりません」+ 一覧へ。422(壊れ frontmatter)→ raw 抜粋を表示(編集機能なし)。
//
// 規約: React 19 / strict / verbatimModuleSyntax / CSS Modules。

import { useCallback, type ReactElement } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { fetchNotes, isApiError, type NoteListResponse } from '../api.js';
import { useRenderedNote } from '../hooks/queries.js';
import { EmptyState, ErrorState, Spinner } from '../components/ui/index.js';
import { CategoryBadge } from '../components/CategoryBadge.js';
import { TagChip } from '../components/TagChip.js';
import { MarkdownView } from '../components/MarkdownView.js';
import styles from './NoteViewPage.module.css';

function strOf(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function strArrayOf(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function formatDate(v: unknown): string {
  const s = strOf(v);
  if (s === '') return '';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString('ja-JP');
}

export default function NoteViewPage(): ReactElement {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const q = searchParams.get('q') ?? undefined;
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const rendered = useRenderedNote(id);

  const onNavigateToNote = useCallback(
    (noteId: string): void => {
      navigate(`/note/${encodeURIComponent(noteId)}`);
    },
    [navigate],
  );

  // 相対 `.md` リンク解決。ページ読み込み時には一覧を取得せず、クリック時のみ遅延取得する。
  // `MarkdownView` の同期シグネチャに合わせ、解決は非同期で行い自身で遷移する(戻り値は null)。
  const resolveMdLink = useCallback(
    (targetPath: string): string | null => {
      void (async () => {
        try {
          const list = await queryClient.fetchQuery<NoteListResponse>({
            queryKey: ['notes', {}],
            queryFn: () => fetchNotes({}),
          });
          const hit = list.items.find((n) => n.path === targetPath);
          if (hit !== undefined) navigate(`/note/${encodeURIComponent(hit.id)}`);
        } catch {
          /* 解決できなければ何もしない(リンクは不活性のまま) */
        }
      })();
      return null;
    },
    [queryClient, navigate],
  );

  if (id === undefined || id === '') {
    return <EmptyState title="ノートが指定されていません" action={<Link to="/">一覧へ</Link>} />;
  }

  if (rendered.isPending) {
    return <Spinner label="ノートを読み込み中" />;
  }

  if (rendered.error !== null) {
    const err = rendered.error;
    if (isApiError(err) && err.status === 404) {
      return (
        <EmptyState
          title="このノートは見つかりません(削除/移動された可能性があります)"
          action={<Link to="/">一覧へ戻る</Link>}
        />
      );
    }
    if (isApiError(err) && err.status === 422) {
      const details = err.details;
      const rawExcerpt = strOf(details['rawExcerpt']);
      const detailMessage = strOf(details['message']);
      const filePath = strOf(details['path']);
      return (
        <section aria-label="壊れた frontmatter">
          <h1>frontmatter を解析できません</h1>
          <p>
            このノートの frontmatter に問題があるため整形表示できません。編集は Obsidian
            などのエディタで行ってください。
          </p>
          {detailMessage !== '' ? <p role="alert">{detailMessage}</p> : null}
          {filePath !== '' ? (
            <p>
              <code>{filePath}</code>
            </p>
          ) : null}
          {rawExcerpt !== '' ? (
            <pre aria-label="raw frontmatter 抜粋" className={styles.brokenPre}>
              {rawExcerpt}
            </pre>
          ) : null}
          <p>
            <Link to="/">一覧へ戻る</Link>
          </p>
        </section>
      );
    }
    return <ErrorState error={err} onRetry={() => void rendered.refetch()} />;
  }

  const note = rendered.data;
  const fm = note.frontmatter;
  const title = strOf(fm['title']) || note.id;
  const categories = strArrayOf(fm['categories']);
  const tags = strArrayOf(fm['tags']);
  const created = formatDate(fm['created']);
  const updated = formatDate(fm['updated']);
  const filePath = note.path;

  const copyPath = (): void => {
    if (filePath === '') return;
    void navigator.clipboard?.writeText(filePath);
  };

  return (
    <section aria-label="NoteViewPage">
      <header className={styles.header}>
        <h1>{title}</h1>
        {categories.length > 0 ? (
          <p aria-label="カテゴリ" className={styles.badges}>
            {categories.map((cat) => (
              <CategoryBadge key={cat} path={cat} />
            ))}
          </p>
        ) : null}
        {tags.length > 0 ? (
          <p aria-label="タグ" className={styles.badges}>
            {tags.map((tag) => (
              <TagChip key={tag} tag={tag} />
            ))}
          </p>
        ) : null}
        <p className={styles.meta}>
          {created !== '' ? <span>作成: {created}</span> : null}
          {updated !== '' ? <span className={styles.metaSep}>更新: {updated}</span> : null}
        </p>
        <p className={styles.actions}>
          <button type="button" onClick={copyPath} disabled={filePath === ''}>
            元ファイルのパスをコピー
          </button>
          {filePath !== '' ? (
            <a href={`obsidian://open?path=${encodeURIComponent(filePath)}`}>Obsidian で開く</a>
          ) : null}
        </p>
      </header>

      <MarkdownView
        html={note.html}
        headings={note.headings}
        notePath={filePath}
        query={q}
        resolveMdLink={resolveMdLink}
        onNavigateToNote={onNavigateToNote}
      />
    </section>
  );
}
