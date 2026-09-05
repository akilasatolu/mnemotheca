import type { ButtonHTMLAttributes, ReactElement } from 'react';
import styles from '../../styles/app.module.css';
import { Spinner } from './Spinner.js';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary';
  loading?: boolean;
}

export function Button({
  variant = 'default',
  loading = false,
  disabled,
  children,
  ...rest
}: ButtonProps): ReactElement {
  return (
    <button
      type="button"
      className={styles.button}
      data-variant={variant}
      disabled={disabled ?? loading}
      {...rest}
    >
      {loading ? <Spinner /> : null}
      {children}
    </button>
  );
}
