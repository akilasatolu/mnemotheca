// src/web/src/context/ToastContext.tsx — 軽量な通知(トースト)ストア(設計 §11-1)。
//
// グローバル store ライブラリは使わず Context のみ。`<Toaster/>` が AppShell に置かれる。

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import styles from '../styles/app.module.css';

export type ToastKind = 'info' | 'success' | 'error';

export interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
}

interface ToastValue {
  toasts: Toast[];
  push: (message: string, kind?: ToastKind) => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastValue | null>(null);

const AUTO_DISMISS_MS = 5000;

export function ToastProvider({ children }: { children: ReactNode }): ReactElement {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((cur) => cur.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (message: string, kind: ToastKind = 'info') => {
      const id = nextId.current++;
      setToasts((cur) => [...cur, { id, message, kind }]);
      if (typeof window !== 'undefined') {
        window.setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
      }
    },
    [dismiss],
  );

  const value = useMemo<ToastValue>(() => ({ toasts, push, dismiss }), [toasts, push, dismiss]);

  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

export function useToast(): ToastValue {
  const v = useContext(ToastContext);
  if (v === null) throw new Error('useToast must be used within <ToastProvider>');
  return v;
}

/** トーストの表示。AppShell の末尾に置く。 */
export function Toaster(): ReactElement | null {
  const { toasts, dismiss } = useToast();
  if (toasts.length === 0) return null;
  return (
    <div className={styles.toaster} role="region" aria-label="通知">
      {toasts.map((t) => (
        <div key={t.id} className={styles.toast} data-kind={t.kind} role="status">
          <span>{t.message}</span>
          <button type="button" aria-label="閉じる" onClick={() => dismiss(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
