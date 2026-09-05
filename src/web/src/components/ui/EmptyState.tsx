import type { ReactElement, ReactNode } from 'react';
import styles from '../../styles/app.module.css';

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}): ReactElement {
  return (
    <div className={styles.state} role="status">
      <p>{title}</p>
      {description !== undefined ? <p>{description}</p> : null}
      {action !== undefined ? <div>{action}</div> : null}
    </div>
  );
}
