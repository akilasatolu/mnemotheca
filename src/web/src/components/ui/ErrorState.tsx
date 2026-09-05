import type { ReactElement } from 'react';
import styles from '../../styles/app.module.css';
import { isApiError } from '../../api.js';
import { Button } from './Button.js';

export function ErrorState({
  error,
  onRetry,
}: {
  error?: unknown;
  onRetry?: () => void;
}): ReactElement {
  let message = '読み込みに失敗しました。';
  if (isApiError(error)) message = error.message;
  else if (error instanceof Error) message = error.message;

  return (
    <div className={styles.state} role="alert">
      <p>{message}</p>
      {onRetry !== undefined ? (
        <Button variant="primary" onClick={onRetry}>
          再試行
        </Button>
      ) : null}
    </div>
  );
}
