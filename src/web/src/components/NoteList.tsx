// src/web/src/components/NoteList.tsx — 右ペインのノート一覧(設計 §11-3 / §11-4 / §11-1)。
//
// - `NoteSummary[]` を `@tanstack/react-virtual` で仮想スクロール表示。
// - ソート切替: 更新日時(既定 desc)/ 作成日時 / タイトル。並び順トグル(asc/desc)。
// - 実際の fetch は親(CategoryListPage)が `useNotes` で行う。ここは表示のみ。

import { useRef, type ReactElement } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { NoteSummary } from '../api.js';
import { NoteCard } from './NoteCard.js';
import styles from './NoteList.module.css';

export type SortKey = 'updated' | 'created' | 'title';
export type SortOrder = 'asc' | 'desc';

const SORT_LABELS: Record<SortKey, string> = {
  updated: '更新日時',
  created: '作成日時',
  title: 'タイトル',
};

interface NoteListProps {
  notes: NoteSummary[];
  total: number;
  sort: SortKey;
  order: SortOrder;
  onSortChange: (sort: SortKey) => void;
  onOrderChange: (order: SortOrder) => void;
}

export function NoteList({
  notes,
  total,
  sort,
  order,
  onSortChange,
  onOrderChange,
}: NoteListProps): ReactElement {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: notes.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 110,
    overscan: 8,
  });

  return (
    <section aria-label="ノート一覧" className={styles.root}>
      <div className={styles.toolbar}>
        <span aria-hidden="true">並び替え:</span>
        <select
          aria-label="並び替え"
          value={sort}
          onChange={(e) => onSortChange(e.target.value as SortKey)}
        >
          {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
            <option key={k} value={k}>
              {SORT_LABELS[k]}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={styles.orderBtn}
          aria-label={order === 'desc' ? '降順(クリックで昇順)' : '昇順(クリックで降順)'}
          onClick={() => onOrderChange(order === 'desc' ? 'asc' : 'desc')}
        >
          {order === 'desc' ? '↓ 降順' : '↑ 昇順'}
        </button>
        <span className={styles.count}>{total} 件</span>
      </div>

      <div ref={parentRef} className={styles.scroll}>
        <div className={styles.inner} style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const note = notes[vi.index];
            if (note === undefined) return null;
            return (
              <div
                key={note.id}
                data-index={vi.index}
                ref={virtualizer.measureElement}
                className={styles.rowWrap}
                style={{ transform: `translateY(${vi.start}px)` }}
              >
                <NoteCard note={note} />
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
