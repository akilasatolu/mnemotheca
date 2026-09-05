import type { ReactElement } from 'react';
import styles from '../../styles/app.module.css';

export function Spinner({ label = '読み込み中' }: { label?: string }): ReactElement {
  return <span className={styles.spinner} role="status" aria-label={label} />;
}
