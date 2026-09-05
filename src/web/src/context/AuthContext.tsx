// src/web/src/context/AuthContext.tsx — Bearer トークンの取得・保持(設計 §10-1「認証」)。
//
// 初回ロード時:
//   1. `location.search` の `t` を読む
//   2. あれば `sessionStorage['mnemo_token']` に保存
//   3. `history.replaceState` で URL から `t` を除去(履歴・共有でトークンが漏れないように)
//   4. 以降 api.ts が `setTokenGetter` 経由で `Authorization: Bearer <token>` を付与

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { setTokenGetter } from '../api.js';

export const TOKEN_STORAGE_KEY = 'mnemo_token';

interface AuthValue {
  token: string | null;
}

const AuthContext = createContext<AuthValue>({ token: null });

function readSession(): string | null {
  try {
    return window.sessionStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** `?t=` を消化して初期トークンを決める(初回レンダリング前に 1 度だけ)。 */
function bootstrapToken(): string | null {
  let token = readSession();

  let search: string;
  try {
    search = window.location.search;
  } catch {
    return token;
  }

  const params = new URLSearchParams(search);
  const fromUrl = params.get('t');
  if (fromUrl !== null && fromUrl !== '') {
    token = fromUrl;
    try {
      window.sessionStorage.setItem(TOKEN_STORAGE_KEY, fromUrl);
    } catch {
      /* private mode 等。メモリ上のトークンで継続する */
    }
    params.delete('t');
    const rest = params.toString();
    const newUrl =
      window.location.pathname + (rest === '' ? '' : `?${rest}`) + window.location.hash;
    try {
      window.history.replaceState(null, '', newUrl);
    } catch {
      /* jsdom 等で失敗しても致命的ではない */
    }
  }
  return token;
}

export function AuthProvider({ children }: { children: ReactNode }): ReactElement {
  const [token] = useState<string | null>(bootstrapToken);

  useEffect(() => {
    // api.ts には常に最新の sessionStorage 値を渡す(フォールバックは state)。
    setTokenGetter(() => readSession() ?? token);
    return () => setTokenGetter(() => null);
  }, [token]);

  return <AuthContext.Provider value={{ token }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  return useContext(AuthContext);
}
