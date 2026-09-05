// test/server/routes/health.test.ts — 設計 §10-1 / §13-12(healthz 該当分)/ §13-13。
//
// `createHealthRoutes(deps)` 単体を `new Hono().route('/', r)` でマウントし `app.request()` で叩く
// (createApp 全体を使わない軽量方式)。

import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createHealthRoutes, type HealthRouteDeps, type HealthzResponse } from '../../../src/server/routes/health.js';

function deps(over: Partial<HealthRouteDeps> = {}): HealthRouteDeps {
  return {
    projectRoot: '/tmp/proj-x',
    vaultPath: '/tmp/proj-x/vault',
    port: 7777,
    startedAt: '2026-09-03T10:00:00.000Z',
    version: '1.2.3',
    ...over,
  };
}

function mount(over: Partial<HealthRouteDeps> = {}): Hono {
  return new Hono().route('/', createHealthRoutes(deps(over)));
}

describe('createHealthRoutes — GET /healthz(§10-1 / §13-12)', () => {
  it('認証ヘッダ無しで 200 を返す', async () => {
    const res = await mount().request('/healthz');
    expect(res.status).toBe(200);
  });

  it('誤った Authorization ヘッダを送っても 200(healthz は無認証)', async () => {
    const res = await mount().request('/healthz', { headers: { Authorization: 'Bearer nope' } });
    expect(res.status).toBe(200);
  });

  it('レスポンスが設計 §10-1 の schema に厳密一致する', async () => {
    const res = await mount().request('/healthz');
    expect(await res.json()).toEqual({
      ok: true,
      name: 'mnemotheca',
      version: '1.2.3',
      projectRoot: '/tmp/proj-x',
      vaultPath: '/tmp/proj-x/vault',
      port: 7777,
      startedAt: '2026-09-03T10:00:00.000Z',
    });
  });

  it('version / projectRoot / vaultPath / port / startedAt が deps から反映される', async () => {
    const res = await mount({
      version: '9.9.9-test',
      projectRoot: '/home/me/brain',
      vaultPath: '/home/me/brain/vault',
      port: 7801,
      startedAt: '2026-01-01T00:00:00.000Z',
    }).request('/healthz');
    const body = (await res.json()) as HealthzResponse;
    expect(body).toMatchObject({
      version: '9.9.9-test',
      projectRoot: '/home/me/brain',
      vaultPath: '/home/me/brain/vault',
      port: 7801,
      startedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('レスポンスに Bearer トークン等の機密が含まれない', async () => {
    const res = await mount().request('/healthz');
    const text = await res.text();
    expect(text).not.toMatch(/token/i);
  });

  it('他パスは 404(このサブアプリは /healthz のみ)', async () => {
    const res = await mount().request('/api/config');
    expect(res.status).toBe(404);
  });
});
