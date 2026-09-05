// src/web/src/routes/SearchPage.tsx — キーワード検索画面(設計 §11-4「SearchPage」/ §13-15）。
// main.tsx はこのファイルの **default export** をルート要素に結線している(名前 `SearchPage` を維持)。
//
// - `SearchBox` は URL `?q=` と同期・IME 対応・デバウンス 250ms(コンポーネント側に実装)。
// - `/api/search?q=`(`useSearch`)の結果を `SearchResultItem` でスコア降順表示。
// - フィルタ(カテゴリ / タグ)は結果から動的生成しクライアント側で絞り込み。
// - 2 文字未満 → 「2 文字以上入力してください」(フロントで API 呼び出しを抑止。
//   サーバー 400 `QUERY_TOO_SHORT` が返っても同じメッセージ)。
// - 0 件 → 表記ゆれ案内 + カテゴリ一覧(`/`)へのリンク。
// - 「意味検索ではない(キーワード一致のみ)」の注記。
// - 結果クリック → `/note/:id?q=<クエリ>`。

import { useMemo, useState, type ReactElement } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { isApiError } from '../api.js';
import { useSearch } from '../hooks/useSearch.js';
import { SearchBox } from '../components/SearchBox.js';
import { SearchResultItem } from '../components/SearchResultItem.js';
import { ErrorState } from '../components/ui/ErrorState.js';
import { Spinner } from '../components/ui/Spinner.js';
import styles from './SearchPage.module.css';

const MIN_QUERY_LEN = 2;
const TOO_SHORT_MESSAGE = '2 文字以上入力してください';

export default function SearchPage(): ReactElement {
  const [searchParams, setSearchParams] = useSearchParams();
  const q = searchParams.get('q') ?? '';
  const trimmed = q.trim();

  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [activeTag, setActiveTag] = useState<string | null>(null);

  const updateQuery = (next: string): void => {
    setSearchParams(
      (prev) => {
        const sp = new URLSearchParams(prev);
        const value = next.trim();
        if (value === '') sp.delete('q');
        else sp.set('q', value);
        return sp;
      },
      { replace: true },
    );
  };

  const clientTooShort = trimmed.length > 0 && trimmed.length < MIN_QUERY_LEN;
  const query = useSearch(trimmed);
  const serverTooShort = isApiError(query.error) && query.error.code === 'QUERY_TOO_SHORT';
  const showTooShort = clientTooShort || serverTooShort;

  const rawResults = query.data?.results ?? [];

  const allCategories = useMemo(
    () => Array.from(new Set(rawResults.flatMap((r) => r.categories))).sort(),
    [rawResults],
  );
  const allTags = useMemo(() => Array.from(new Set(rawResults.flatMap((r) => r.tags))).sort(), [rawResults]);

  const results = useMemo(
    () =>
      rawResults
        .filter(
          (r) =>
            (activeCategory === null || r.categories.includes(activeCategory)) &&
            (activeTag === null || r.tags.includes(activeTag)),
        )
        .slice()
        .sort((a, b) => b.score - a.score),
    [rawResults, activeCategory, activeTag],
  );

  const toggle =
    (current: string | null, set: (v: string | null) => void) =>
    (value: string): void => {
      set(current === value ? null : value);
    };

  return (
    <section className={styles.page} aria-label="SearchPage">
      <h1>検索</h1>

      <SearchBox value={q} onChange={updateQuery} />

      <p className={styles.note} role="note">
        キーワード(部分一致)検索です。意味の近さでは検索しません。
      </p>

      {showTooShort ? (
        <p className={styles.message} role="status">
          {TOO_SHORT_MESSAGE}
        </p>
      ) : trimmed.length < MIN_QUERY_LEN ? (
        <p className={styles.message} role="status">
          キーワードを入力してください。
        </p>
      ) : query.isLoading ? (
        <Spinner />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data ? (
        <>
          {allCategories.length > 0 || allTags.length > 0 ? (
            <div className={styles.filters} aria-label="絞り込み">
              {allCategories.map((c) => (
                <button
                  key={`c-${c}`}
                  type="button"
                  aria-pressed={activeCategory === c}
                  onClick={() => toggle(activeCategory, setActiveCategory)(c)}
                >
                  {c}
                </button>
              ))}
              {allTags.map((t) => (
                <button
                  key={`t-${t}`}
                  type="button"
                  aria-pressed={activeTag === t}
                  onClick={() => toggle(activeTag, setActiveTag)(t)}
                >
                  #{t}
                </button>
              ))}
            </div>
          ) : null}

          {results.length === 0 ? (
            rawResults.length === 0 ? (
              <div className={styles.message} role="status">
                <p>
                  該当なし。表記ゆれの可能性があります(カタカナ / 英語、送り仮名)。タグやカテゴリからも探せます。
                </p>
                <Link to="/">カテゴリ一覧から探す</Link>
              </div>
            ) : (
              <p className={styles.message} role="status">
                絞り込み条件に一致する結果がありません。
              </p>
            )
          ) : (
            <>
              <p className={styles.count}>{results.length} 件</p>
              <ul className={styles.list}>
                {results.map((r) => (
                  <SearchResultItem key={r.id} result={r} query={trimmed} />
                ))}
              </ul>
            </>
          )}
        </>
      ) : null}
    </section>
  );
}
