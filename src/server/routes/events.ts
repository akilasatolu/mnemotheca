// src/server/routes/events.ts — `GET /api/events`(SSE。設計 §10-1 エンドポイント表 + 「認証」節 / §6-5 / §13-13)。
//
// 責務:
//   - `?t=<token>` によるクエリ認証(§10-1「認証」の SSE 例外。`Authorization: Bearer` があれば優先)。
//     不一致 / 欠落 → `401`(SSE ではなく通常 JSON レスポンス)。
//   - `text/event-stream` で接続を維持し、`deps.subscribe` 経由で受け取った watcher の
//     `index-updated` イベントを `data: {"type":"index-updated",...}\n\n` で送出する。
//   - クライアント切断で購読解除(`stream.onAbort`)。
//   - keepalive コメント `:\n\n` を定期送出(既定 15s)。
//
// watcher とのペイロード整合(decision-log #49 OBS-1): watcher の `onIndexUpdated` は
// `{ type: 'index-updated', changed }` を渡す(§6-5 の `counts:{added,updated,removed}` ではない)。
// SSE ではその payload をそのまま流す。件数(counts)は `POST /api/reindex` の戻り値で返す。
//
// boot / 結線: `deps.subscribe` は watcher の `onIndexUpdated(cb)` をそのまま渡す想定
// (`createWatcher(...).onIndexUpdated` は unsubscribe 関数を返すのでシグネチャが一致する)。
// watcher が EventEmitter を公開していないため、この結線は boot.ts 側の責務。
//
// 認証以外の共通ヘッダ(`Referrer-Policy` / `Cache-Control`)は `server/app.ts` が付与する。
//
// 規約: ESM / NodeNext / strict / verbatimModuleSyntax / noUncheckedIndexedAccess。

import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';

/** SSE で流すイベント payload(watcher の `IndexUpdatedPayload` 互換)。 */
export interface IndexEventPayload {
  type: string;
  [key: string]: unknown;
}

/** `createEventsRoutes` の依存(boot.ts が用意する)。 */
export interface EventsRoutesDeps {
  /** サーバー起動時に生成した Bearer トークン(`run.json` と同値)。`?t=` の照合に使う。 */
  token: string;
  /**
   * インデックス更新イベントの購読関数。`cb` を登録し、解除関数を返す。
   * boot 側で `createWatcher(...).onIndexUpdated` をそのまま渡す。
   */
  subscribe: (cb: (payload: IndexEventPayload) => void) => () => void;
  /** keepalive コメントの送出間隔(ms)。既定 15000。0 以下で無効。 */
  keepaliveMs?: number;
}

const DEFAULT_KEEPALIVE_MS = 15_000;

/** 長さに依存しない定数時間トークン比較(app.ts と同じ実装)。 */
function tokensMatch(expected: string, presented: string | undefined | null): boolean {
  if (typeof presented !== 'string' || presented.length === 0) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function errorBody(code: string, message: string): {
  error: { code: string; message: string; details: Record<string, unknown> };
} {
  return { error: { code, message, details: {} } };
}

/**
 * `GET /events`(SSE)サブアプリを生成する。結線側は `/api` 直下にマウントする
 * (`api.route('/', createEventsRoutes(deps))` → `GET /api/events`)。
 */
export function createEventsRoutes(deps: EventsRoutesDeps): Hono {
  const r = new Hono();
  const keepaliveMs = deps.keepaliveMs ?? DEFAULT_KEEPALIVE_MS;

  r.get('/events', (c) => {
    const authHeader = c.req.header('Authorization');
    let presented: string | undefined;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      presented = authHeader.slice('Bearer '.length).trim();
    } else {
      presented = c.req.query('t');
    }
    if (!tokensMatch(deps.token, presented)) {
      return c.json(errorBody('UNAUTHORIZED', '認証に失敗しました。'), 401);
    }

    return streamSSE(c, async (stream) => {
      let ka: ReturnType<typeof setInterval> | null = null;
      const unsub = deps.subscribe((payload) => {
        void stream.writeSSE({ data: JSON.stringify(payload) });
      });
      const cleanup = (): void => {
        unsub();
        if (ka) {
          clearInterval(ka);
          ka = null;
        }
      };

      if (keepaliveMs > 0) {
        ka = setInterval(() => {
          void stream.write(':\n\n');
        }, keepaliveMs);
        ka.unref?.();
      }

      stream.onAbort(cleanup);

      try {
        while (!stream.aborted) {
          await stream.sleep(1000);
        }
      } finally {
        cleanup();
      }
    });
  });

  return r;
}

export default createEventsRoutes;
