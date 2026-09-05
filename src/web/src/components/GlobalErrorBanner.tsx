// src/web/src/components/GlobalErrorBanner.tsx — vault 不達(503)の全画面共通バナー(設計 §11-2)。
//
// React Query の QueryCache.onError(main.tsx で結線)が `reportApiError` を呼ぶ。
// vault 系 503 のときだけバナーを表示し、`mnemo doctor` を案内する。
// 破壊的操作ではないので Context は使わず軽量な外部ストア + useSyncExternalStore。

import { useSyncExternalStore, type ReactElement } from 'react';
import styles from '../styles/app.module.css';
import { isApiError } from '../api.js';

let vaultError: string | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** QueryCache.onError などから呼ぶ。vault 系 503 のときだけバナーを立てる。 */
export function reportApiError(error: unknown): void {
  if (!isApiError(error)) return;
  if (error.status !== 503) return;
  if (error.code !== 'VAULT_UNAVAILABLE' && error.code !== 'VAULT_NOT_WRITABLE') return;
  if (vaultError !== null) return;
  vaultError = error.message !== '' ? error.message : 'vault にアクセスできません';
  emit();
}

/** 再インデックス成功時など、明示的にバナーを消す。 */
export function clearGlobalError(): void {
  if (vaultError === null) return;
  vaultError = null;
  emit();
}

/** テスト用リセット。 */
export function __resetGlobalErrorForTest(): void {
  vaultError = null;
  emit();
}

export function GlobalErrorBanner(): ReactElement | null {
  const error = useSyncExternalStore(
    subscribe,
    () => vaultError,
    () => vaultError,
  );
  if (error === null) return null;
  return (
    <div className={styles.globalBanner} role="alert">
      vault/ にアクセスできません。projectRoot 内で <code>mnemo doctor</code> を実行してください。
    </div>
  );
}
