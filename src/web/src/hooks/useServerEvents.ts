// src/web/src/hooks/useServerEvents.ts — SSE 購読(設計 §10-1 / §11-5)。
//
// `new EventSource('/api/events?t=' + token)`(EventSource はヘッダを送れないためクエリ認証)。
// `index-updated` を受信したら ['notes'] / ['categories'] / ['search'] / ['dashboard'] を invalidate。

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext.js';

const INVALIDATE_KEYS = [['notes'], ['categories'], ['search'], ['dashboard']] as const;

export function useServerEvents(): void {
  const { token } = useAuth();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (token === null || token === '') return;
    if (typeof EventSource === 'undefined') return;

    const es = new EventSource(`/api/events?t=${encodeURIComponent(token)}`);

    const handle = (ev: MessageEvent): void => {
      let type = '';
      try {
        const parsed = JSON.parse(ev.data as string) as { type?: unknown };
        if (typeof parsed.type === 'string') type = parsed.type;
      } catch {
        return;
      }
      if (type !== 'index-updated') return;
      for (const queryKey of INVALIDATE_KEYS) {
        void queryClient.invalidateQueries({ queryKey: [...queryKey] });
      }
    };

    es.addEventListener('message', handle);
    // 名前付きイベントで送られてくる実装にも一応対応する(現状は message)。
    es.addEventListener('index-updated', handle as EventListener);

    return () => {
      es.removeEventListener('message', handle);
      es.removeEventListener('index-updated', handle as EventListener);
      es.close();
    };
  }, [token, queryClient]);
}
