// test/server/app.test.ts — 設計 §13-13 / §10-1。
//
// createApp の認証ミドルウェア(Bearer / `?t=` 例外)、無認証 /healthz、
// セキュリティ・キャッシュヘッダ、MnemoError → 共通エラー形式 + ステータスマッピング、
// 静的配信 + SPA フォールバックを検証する。routes/* はまだ無いので、テスト内で
// ダミーの保護ルータ(`new Hono()`)を注入して確認する。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createApp, errorToStatus, type CreateAppDeps } from '../../src/server/app.js';
import { MnemoError, type ErrorCode } from '../../src/core/errors.js';

const TOKEN = 'test-secret-token-abc123';

type ErrBody = { error: { code: string; message?: string; details?: unknown } };
async function jsonBody<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function makeWebRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemo-web-'));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>SPA</title>');
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log("asset")');
  return dir;
}

function baseDeps(over: Partial<CreateAppDeps> = {}): CreateAppDeps {
  return {
    projectRoot: '/tmp/proj',
    token: TOKEN,
    port: 4711,
    startedAt: '2026-09-03T00:00:00.000Z',
    version: '9.9.9',
    ...over,
  };
}

/** ダミーの保護ルータ(routes/* の代役)。 */
function dummyApi(): Hono {
  const api = new Hono();
  api.get('/notes', (c) => c.json({ total: 0, items: [] }));
  api.get('/events', (c) => c.body('data: {"type":"index-updated"}\n\n', 200, { 'Content-Type': 'text/event-stream' }));
  api.get('/boom/:code', (c) => {
    throw new MnemoError(c.req.param('code') as ErrorCode, `boom ${c.req.param('code')}`, { hint: 'x' });
  });
  api.get('/unexpected', () => {
    throw new Error('kaboom');
  });
  return api;
}

function makeApp(over: Partial<CreateAppDeps> = {}): Hono {
  return createApp(baseDeps({ webRoot: makeWebRoot(), ...over }), dummyApi());
}

function bearer(t = TOKEN): Record<string, string> {
  return { Authorization: `Bearer ${t}` };
}

describe('createApp — 認証(§13-13)', () => {
  it('トークン無しで /api/notes → 401 + 共通エラー形式', async () => {
    const res = await makeApp().request('/api/notes');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: 'UNAUTHORIZED', message: expect.any(String), details: {} },
    });
  });

  it('誤ったトークンで /api/notes → 401', async () => {
    const res = await makeApp().request('/api/notes', { headers: bearer('wrong') });
    expect(res.status).toBe(401);
  });

  it('正しい Bearer トークンで /api/notes → 200', async () => {
    const res = await makeApp().request('/api/notes', { headers: bearer() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ total: 0, items: [] });
  });

  it('Authorization ヘッダが Bearer スキームでない → 401', async () => {
    const res = await makeApp().request('/api/notes', { headers: { Authorization: TOKEN } });
    expect(res.status).toBe(401);
  });

  it('/healthz は無認証で 200 + 設計どおりの形', async () => {
    const res = await makeApp().request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      name: 'mnemotheca',
      version: '9.9.9',
      projectRoot: '/tmp/proj',
      vaultPath: path.join('/tmp/proj', 'vault'),
      port: 4711,
      startedAt: '2026-09-03T00:00:00.000Z',
    });
  });

  it('vaultPath を明示指定すると /healthz に反映される', async () => {
    const res = await makeApp({ vaultPath: '/custom/vault' }).request('/healthz');
    expect((await jsonBody<{ vaultPath: string }>(res)).vaultPath).toBe('/custom/vault');
  });
});

describe('createApp — GET /api/events の ?t= 認証(§10-1 例外)', () => {
  it('?t= が一致 → 200(EventSource 相当)', async () => {
    const res = await makeApp().request(`/api/events?t=${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');
  });

  it('?t= が不一致 → 401(SSE ではなく通常レスポンス)', async () => {
    const res = await makeApp().request('/api/events?t=nope');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: 'UNAUTHORIZED', message: expect.any(String), details: {} },
    });
  });

  it('?t= 欠落 → 401', async () => {
    const res = await makeApp().request('/api/events');
    expect(res.status).toBe(401);
  });

  it('ヘッダがあればヘッダを優先(?t= が誤りでもヘッダが正しければ 200)', async () => {
    const res = await makeApp().request('/api/events?t=nope', { headers: bearer() });
    expect(res.status).toBe(200);
  });

  it('ヘッダが誤りなら ?t= が正しくても 401(ヘッダ優先)', async () => {
    const res = await makeApp().request(`/api/events?t=${TOKEN}`, { headers: bearer('wrong') });
    expect(res.status).toBe(401);
  });

  it('?t= 認証は /api/events 以外には効かない(/api/notes?t= → 401)', async () => {
    const res = await makeApp().request(`/api/notes?t=${TOKEN}`);
    expect(res.status).toBe(401);
  });
});

describe('createApp — セキュリティ / キャッシュヘッダ(§10-1)', () => {
  it('全レスポンスに Referrer-Policy: no-referrer(/healthz)', async () => {
    const res = await makeApp().request('/healthz');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
  });

  it('401 レスポンスにも Referrer-Policy: no-referrer', async () => {
    const res = await makeApp().request('/api/notes');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
  });

  it('/api/* に Cache-Control: no-store', async () => {
    const res = await makeApp().request('/api/notes', { headers: bearer() });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('/healthz には Cache-Control: no-store を付けない', async () => {
    const res = await makeApp().request('/healthz');
    expect(res.headers.get('Cache-Control')).toBeNull();
  });
});

describe('createApp — MnemoError → 共通エラー形式 + ステータス(§10-1 / §12-1)', () => {
  const cases: Array<[ErrorCode, number]> = [
    ['UNAUTHORIZED', 401],
    ['QUERY_TOO_SHORT', 400],
    ['LOCK_TIMEOUT', 409],
    ['SLUG_COLLISION', 409],
    ['FRONTMATTER_PARSE', 422],
    ['FRONTMATTER_SCHEMA', 422],
    ['CATEGORY_INVARIANT', 422],
    ['PII_BLOCKED', 422],
    ['ORGANIZE_SESSION_EXPIRED', 422],
    ['VAULT_UNAVAILABLE', 503],
    ['VAULT_NOT_WRITABLE', 503],
    ['INDEX_BUILD_FAILED', 503],
    ['NOT_INITIALIZED', 500],
    ['PORT_UNAVAILABLE', 500],
  ];

  for (const [code, status] of cases) {
    it(`${code} → ${status} + { error: { code, message, details } }`, async () => {
      const res = await makeApp().request(`/api/boom/${code}`, { headers: bearer() });
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({
        error: { code, message: `boom ${code}`, details: { hint: 'x' } },
      });
      // エラー応答にもヘッダが付く
      expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(res.headers.get('Cache-Control')).toBe('no-store');
    });
  }

  it('errorToStatus は直接呼んでも同じマッピングを返す', () => {
    expect(errorToStatus('UNAUTHORIZED')).toBe(401);
    expect(errorToStatus('QUERY_TOO_SHORT')).toBe(400);
    expect(errorToStatus('SLUG_COLLISION')).toBe(409);
    expect(errorToStatus('FRONTMATTER_SCHEMA')).toBe(422);
    expect(errorToStatus('VAULT_UNAVAILABLE')).toBe(503);
    expect(errorToStatus('NODE_VERSION_UNSUPPORTED')).toBe(500);
  });

  it('想定外の Error → 500 + INTERNAL', async () => {
    const res = await makeApp().request('/api/unexpected', { headers: bearer() });
    expect(res.status).toBe(500);
    expect((await jsonBody<ErrBody>(res)).error.code).toBe('INTERNAL');
  });
});

describe('createApp — /api ルータのマウント & 未定義パス', () => {
  it('apiRouter 未注入でも /api/* は認証を通過後 404(共通エラー形式)', async () => {
    const app = createApp(baseDeps({ webRoot: makeWebRoot() }));
    const res = await app.request('/api/whatever', { headers: bearer() });
    expect(res.status).toBe(404);
    expect((await jsonBody<ErrBody>(res)).error.code).toBe('NOT_FOUND');
  });

  it('apiRouter があっても未定義の /api パスは 404', async () => {
    const res = await makeApp().request('/api/does-not-exist', { headers: bearer() });
    expect(res.status).toBe(404);
    expect((await jsonBody<ErrBody>(res)).error.code).toBe('NOT_FOUND');
  });
});

describe('createApp — 静的配信 + SPA フォールバック(§1-2)', () => {
  it('実ファイルを配信する', async () => {
    const res = await makeApp().request('/app.js');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('asset');
  });

  it('ルートは index.html', async () => {
    const res = await makeApp().request('/');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('SPA');
  });

  it('未知のクライアントルートは index.html にフォールバック(200)', async () => {
    const res = await makeApp().request('/notes/20260101T000000000abcde');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('SPA');
  });

  it('webRoot が存在しなくても API は動き、静的パスは 404 を返す', async () => {
    const app = createApp(baseDeps({ webRoot: '/nonexistent/mnemo/web' }), dummyApi());
    expect((await app.request('/healthz')).status).toBe(200);
    const res = await app.request('/some-page');
    expect(res.status).toBe(404);
  });
});
