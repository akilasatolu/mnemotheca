// src/web/src/components/NoteCard.tsx — 一覧の 1 ノート行(設計 §11-3)。
// タイトル / summary / タグ / カテゴリ / 日付。行クリックで `/note/:id`。

import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import type { NoteSummary } from '../api.js';
import { CategoryBadge } from './CategoryBadge.js';
import { TagChip } from './TagChip.js';
import styles from './NoteCard.module.css';

function formatDate(iso: string): string {
  if (iso === '') return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 10);
}

export function NoteCard({ note }: { note: NoteSummary }): ReactElement {
  return (
    <article data-testid="note-card" className={styles.card}>
      <h3 className={styles.title}>
        <Link to={`/note/${encodeURIComponent(note.id)}`}>{note.title === '' ? '(無題)' : note.title}</Link>
      </h3>
      {note.summary !== '' ? <p className={styles.summary}>{note.summary}</p> : null}
      <div className={styles.meta}>
        {note.categories.map((c) => (
          <CategoryBadge key={c} path={c} />
        ))}
        {note.tags.map((t) => (
          <TagChip key={t} tag={t} />
        ))}
        <time dateTime={note.updated} className={styles.date}>
          {formatDate(note.updated)}
        </time>
      </div>
    </article>
  );
}
