// src/web/src/routes/CategoryListPage.tsx — カテゴリ別ノート一覧(既定画面。設計 §11-4 / §11-3 / §11-5)。
//
// - 左 `CategoryTree`(`/api/categories`)、右 `NoteList`(`/api/notes?category&tag&sort&order`)。
// - フィルタ状態は URL クエリ `?category` `?tag` `?sort` `?order` が単一の真実(§11-5)。
// - 空状態 / スケルトン / `ErrorState` + 再試行(§11-4)。
//
// main.tsx はこのファイルの default export をルート要素に結線している。default export 名は維持する。

import type { ReactElement } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { EmptyState, ErrorState } from '../components/ui/index.js';
import { CategoryTree } from '../components/CategoryTree.js';
import { NoteList, type SortKey, type SortOrder } from '../components/NoteList.js';
import { useCategories } from '../hooks/useCategories.js';
import { useNotes } from '../hooks/useNotes.js';
import styles from './CategoryListPage.module.css';

const SORT_KEYS: readonly SortKey[] = ['updated', 'created', 'title'];

function parseSort(raw: string | null): SortKey {
  return SORT_KEYS.includes((raw ?? '') as SortKey) ? (raw as SortKey) : 'updated';
}

function parseOrder(raw: string | null): SortOrder {
  return raw === 'asc' ? 'asc' : 'desc';
}

function Skeleton(): ReactElement {
  return (
    <div aria-hidden="true" data-testid="note-list-skeleton" className={styles.skeleton}>
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className={styles.skeletonRow} />
      ))}
    </div>
  );
}

export default function CategoryListPage(): ReactElement {
  const [searchParams, setSearchParams] = useSearchParams();

  const category = searchParams.get('category');
  const tag = searchParams.get('tag');
  const sort = parseSort(searchParams.get('sort'));
  const order = parseOrder(searchParams.get('order'));

  const categoriesQuery = useCategories();
  const notesQuery = useNotes({
    category: category ?? undefined,
    tag: tag ?? undefined,
    sort,
    order,
  });

  const patchParams = (patch: Record<string, string | null>): void => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) {
          if (v === null || v === '') next.delete(k);
          else next.set(k, v);
        }
        return next;
      },
      { replace: false },
    );
  };

  const selectCategory = (path: string | null): void => patchParams({ category: path });

  return (
    <section aria-label="カテゴリ別ノート一覧" className={styles.layout}>
      <aside className={styles.tree}>
        {categoriesQuery.isPending ? (
          <p className={styles.treeStatus}>カテゴリを読み込み中…</p>
        ) : categoriesQuery.isError ? (
          <ErrorState error={categoriesQuery.error} onRetry={() => void categoriesQuery.refetch()} />
        ) : (
          <CategoryTree
            tree={categoriesQuery.data.tree}
            uncategorizedCount={categoriesQuery.data.uncategorizedCount}
            selected={category}
            onSelect={selectCategory}
          />
        )}
      </aside>

      <div className={styles.main}>
        {tag !== null ? (
          <p className={styles.tagFilter}>
            タグ <strong>#{tag}</strong> で絞り込み中{' '}
            <button type="button" className={styles.clearBtn} onClick={() => patchParams({ tag: null })}>
              解除
            </button>
          </p>
        ) : null}

        {notesQuery.isPending ? (
          <Skeleton />
        ) : notesQuery.isError ? (
          <ErrorState error={notesQuery.error} onRetry={() => void notesQuery.refetch()} />
        ) : notesQuery.data.items.length === 0 ? (
          category === null && tag === null ? (
            <EmptyState
              title="まだノートがありません"
              description="Claude に「Mnemotheca に保存して」と話しかけてみてください。"
              action={<Link to="/settings">設定 → MCP 連携スニペットを見る</Link>}
            />
          ) : (
            <EmptyState
              title="このカテゴリ / タグに一致するノートはありません"
              action={
                <button
                  type="button"
                  className={styles.clearBtn}
                  onClick={() => setSearchParams(new URLSearchParams(), { replace: false })}
                >
                  絞り込みを解除
                </button>
              }
            />
          )
        ) : (
          <NoteList
            notes={notesQuery.data.items}
            total={notesQuery.data.total}
            sort={sort}
            order={order}
            onSortChange={(s) => patchParams({ sort: s })}
            onOrderChange={(o) => patchParams({ order: o })}
          />
        )}
      </div>
    </section>
  );
}
