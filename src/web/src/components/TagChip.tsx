// src/web/src/components/TagChip.tsx — タグを表すチップ(設計 §11-3 / §11-2 遷移)。
// クリックで一覧をそのタグで絞り込む(`/?tag=<tag>`。設計は /search?q= も許容だが
// 一覧内で状態が完結する `?tag` を採用)。

import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import styles from './TagChip.module.css';

export function TagChip({ tag }: { tag: string }): ReactElement {
  return (
    <Link to={`/?tag=${encodeURIComponent(tag)}`} data-testid="tag-chip" className={styles.chip}>
      #{tag}
    </Link>
  );
}
