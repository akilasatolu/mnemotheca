// src/web/src/components/SearchResultItem.tsx — 検索結果 1 件(設計 §11-3 / §11-4)。
//
// - タイトルは `/note/:id?q=<クエリ>` へのリンク。
// - `snippet` はサーバー生成済み(§10-1 DTO 注記: 本文を HTML エスケープ後、元クエリ語を
//   `<mark>` で包むだけ。混入しうるタグは `<mark>` のみ)。そのまま `dangerouslySetInnerHTML`。
// - `matchedFields` をチップ表示。カテゴリ / タグも表示。

import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import type { SearchResult } from '../api.js';
import styles from './SearchResultItem.module.css';

export interface SearchResultItemProps {
  result: SearchResult;
  /** 遷移先に引き継ぐ検索クエリ。 */
  query: string;
}

export function SearchResultItem({ result, query }: SearchResultItemProps): ReactElement {
  const to = `/note/${encodeURIComponent(result.id)}?q=${encodeURIComponent(query)}`;
  const hasMeta = result.categories.length > 0 || result.tags.length > 0;

  return (
    <li className={styles.item}>
      <article>
        <h3 className={styles.title}>
          <Link to={to}>{result.title}</Link>
        </h3>
        <p className={styles.snippet} dangerouslySetInnerHTML={{ __html: result.snippet }} />
        {result.matchedFields.length > 0 ? (
          <ul className={styles.chips} aria-label="一致フィールド">
            {result.matchedFields.map((field) => (
              <li key={field}>{field}</li>
            ))}
          </ul>
        ) : null}
        {hasMeta ? (
          <p className={styles.meta}>
            {result.categories.map((c) => (
              <span key={`c-${c}`} data-kind="category">
                {c}
              </span>
            ))}
            {result.tags.map((t) => (
              <span key={`t-${t}`} data-kind="tag">
                #{t}
              </span>
            ))}
          </p>
        ) : null}
      </article>
    </li>
  );
}

export default SearchResultItem;
