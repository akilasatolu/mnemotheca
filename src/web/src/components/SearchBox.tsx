// src/web/src/components/SearchBox.tsx — キーワード検索入力(設計 §11-3 / §11-4 / §13-15)。
//
// - `value`(= URL `?q=`)と同期する。外部からの変更は IME 変換中でなければ取り込む。
// - IME 対応: `compositionstart`〜`compositionend` の間は `onChange`(検索発火)を呼ばない。
//   `compositionend` 後にデバウンス(既定 250ms)で発火。通常入力も同じデバウンス。
// - デバウンス / IME ガードのロジックはこのコンポーネントに閉じており単体テストしやすい。

import { useEffect, useRef, useState, type ChangeEvent, type CompositionEvent, type ReactElement } from 'react';
import styles from './SearchBox.module.css';

export interface SearchBoxProps {
  /** 現在の確定クエリ(通常は URL `?q=`)。 */
  value: string;
  /** デバウンス後に呼ばれる。呼び出し側は URL `?q=` を更新する。 */
  onChange: (next: string) => void;
  /** デバウンス時間(ms)。既定 250。 */
  debounceMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 250;

export function SearchBox({ value, onChange, debounceMs = DEFAULT_DEBOUNCE_MS }: SearchBoxProps): ReactElement {
  const [text, setText] = useState(value);
  const composingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // 外部(URL `?q=`)からの変更を取り込む。IME 変換中と同値は無視。
  useEffect(() => {
    if (!composingRef.current && value !== text) setText(value);
    // text は「取り込み要否」の判定にのみ使う(依存に含めると打鍵ごとに再同期してしまう)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // アンマウント時に保留中のデバウンスを破棄。
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  const schedule = (next: string): void => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      onChangeRef.current(next);
    }, debounceMs);
  };

  const handleChange = (e: ChangeEvent<HTMLInputElement>): void => {
    const next = e.target.value;
    setText(next);
    if (composingRef.current) return; // IME 変換中は検索を発火しない
    schedule(next);
  };

  const handleCompositionStart = (): void => {
    composingRef.current = true;
  };

  const handleCompositionEnd = (e: CompositionEvent<HTMLInputElement>): void => {
    composingRef.current = false;
    const next = e.currentTarget.value;
    setText(next);
    schedule(next); // compositionend 後にデバウンスで発火
  };

  return (
    <input
      type="search"
      className={styles.input}
      aria-label="キーワード検索"
      placeholder="キーワードを入力(2 文字以上)"
      value={text}
      onChange={handleChange}
      onCompositionStart={handleCompositionStart}
      onCompositionEnd={handleCompositionEnd}
    />
  );
}

export default SearchBox;
