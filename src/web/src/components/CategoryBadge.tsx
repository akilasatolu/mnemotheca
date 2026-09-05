// src/web/src/components/CategoryBadge.tsx — カテゴリ経路を表すバッジ(設計 §11-3 / §11-2 遷移)。
// クリックで一覧をそのカテゴリで絞り込む(`/?category=<path>`)。

import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import styles from './CategoryBadge.module.css';

export function CategoryBadge({ path, label }: { path: string; label?: string }): ReactElement {
  const text = label ?? (path === '' || path === '_uncategorized' ? '未分類' : path);
  const target = path === '' ? '_uncategorized' : path;
  return (
    <Link to={`/?category=${encodeURIComponent(target)}`} data-testid="category-badge" className={styles.badge}>
      {text}
    </Link>
  );
}
