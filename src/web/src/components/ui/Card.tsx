import type { HTMLAttributes, ReactElement } from 'react';
import styles from '../../styles/app.module.css';

export function Card({ children, ...rest }: HTMLAttributes<HTMLDivElement>): ReactElement {
  return (
    <div className={styles.card} {...rest}>
      {children}
    </div>
  );
}
