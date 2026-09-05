// test/server/routes/config.test.ts — 設計 §10-1 / §8-B / §13-13。
//
// `createConfigRoutes(deps)` 単体を `/api` にマウントして `app.request('/api/config')` で叩く。
// createApp 全体は使わない(認証は app.ts の責務でここでは検証しない。§13-13 の認証観点は
// test/server/app.test.ts でカバー済み)。

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  createConfigRoutes,
  readIndexMetaFromDisk,
  type ConfigResponse,
  type ConfigRouteDeps,
  type IndexMetaView,
} from '../../../src/server/routes/config.js';
import { makeProject } from '../../helpers/project.js';
import { mnemothecaPaths } from '../../../src/core/paths.js';

const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await fs.promises.rm(r, { recursive: true, force: true });
});

function deps(over: Partial<ConfigRouteDeps> = {}): ConfigRouteDeps {
  return {
    projectRoot: '/tmp/proj-c',
    vaultPath: '/tmp/proj-c/vault',
    port: 7777,
    readIndexMeta: () => Promise.resolve(null),
    ...over,
  };
}

function mount(over: Partial<ConfigRouteDeps> = {}): Hono {
  return new Hono().route('/api', createConfigRoutes(deps(over)));
}

describe('createConfigRoutes — GET /api/config(§10-1 / §13-13)', () => {
  it('200 + 設計 §10-1 の schema ちょうど(余計なキー無し)', async () => {
    const meta: IndexMetaView = { docCount: 12, builtAt: '2026-09-02T12:00:00+09:00' };
    const res = await mount({
      projectRoot: '/x/proj',
      vaultPath: '/x/proj/vault',
      port: 7801,
      readIndexMeta: () => Promise.resolve(meta),
    }).request('/api/config');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      projectRoot: '/x/proj',
      vaultPath: '/x/proj/vault',
      noteCount: 12,
      indexBuiltAt: '2026-09-02T12:00:00+09:00',
      serverPort: 7801,
    });
  });

  it('機密フィールド(token / secret / config.json 生値)がレスポンスに出ない', async () => {
    const res = await mount({
      // deps に紛れ込ませても出力に載らないこと
      readIndexMeta: () => Promise.resolve({ docCount: 1, builtAt: 'x' }),
    }).request('/api/config');
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      ['indexBuiltAt', 'noteCount', 'projectRoot', 'serverPort', 'vaultPath'].sort(),
    );
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/token/i);
    expect(text).not.toMatch(/secret/i);
    expect(text).not.toMatch(/authorization/i);
  });

  it('インデックス未ビルド(meta 無し)→ noteCount 0 / indexBuiltAt null', async () => {
    const res = await mount({ readIndexMeta: () => Promise.resolve(null) }).request('/api/config');
    const body = (await res.json()) as ConfigResponse;
    expect(body.noteCount).toBe(0);
    expect(body.indexBuiltAt).toBeNull();
  });

  it('meta あり → docCount / builtAt が noteCount / indexBuiltAt に反映', async () => {
    const res = await mount({
      readIndexMeta: () => Promise.resolve({ docCount: 128, builtAt: '2026-09-02T12:00:00+09:00' }),
    }).request('/api/config');
    const body = (await res.json()) as ConfigResponse;
    expect(body.noteCount).toBe(128);
    expect(body.indexBuiltAt).toBe('2026-09-02T12:00:00+09:00');
  });

  it('未定義メソッド(PUT /api/config)→ 404(設計 §13-13: vault 変更 API は存在しない)', async () => {
    const app = mount();
    expect((await app.request('/api/config', { method: 'PUT', body: '{}' })).status).toBe(404);
    expect((await app.request('/api/config', { method: 'PATCH' })).status).toBe(404);
    expect((await app.request('/api/config', { method: 'DELETE' })).status).toBe(404);
  });

  it('GET は config.json に一切書き込まない(§8-B git churn 不変条件)', async () => {
    const root = await makeProject();
    roots.push(root);
    const cfgPath = path.join(root, '.mnemotheca', 'config.json');
    const before = await fs.promises.readFile(cfgPath);
    const mtimeBefore = (await fs.promises.stat(cfgPath)).mtimeMs;

    const app = new Hono().route(
      '/api',
      createConfigRoutes({ projectRoot: root, vaultPath: path.join(root, 'vault'), port: 7777 }),
    );
    await app.request('/api/config');
    await app.request('/api/config');

    expect(await fs.promises.readFile(cfgPath)).toEqual(before);
    expect((await fs.promises.stat(cfgPath)).mtimeMs).toBe(mtimeBefore);
  });
});

describe('readIndexMetaFromDisk(§6-2)', () => {
  it('meta.json 無し → null', async () => {
    const root = await makeProject();
    roots.push(root);
    expect(await readIndexMetaFromDisk(root)).toBeNull();
  });

  it('正常な meta.json → { docCount, builtAt } を抜き出す', async () => {
    const root = await makeProject();
    roots.push(root);
    const { metaJson } = mnemothecaPaths(root);
    await fs.promises.writeFile(
      metaJson,
      JSON.stringify({
        v: 1,
        schemaVersion: 1,
        tokenizerVersion: 1,
        fields: [],
        storeFields: [],
        builtAt: '2026-09-02T12:00:00+09:00',
        docCount: 7,
        docs: {},
      }),
    );
    expect(await readIndexMetaFromDisk(root)).toEqual({
      docCount: 7,
      builtAt: '2026-09-02T12:00:00+09:00',
    });
  });

  it('JSON 破損 → null', async () => {
    const root = await makeProject();
    roots.push(root);
    const { metaJson } = mnemothecaPaths(root);
    await fs.promises.writeFile(metaJson, '{ not json');
    expect(await readIndexMetaFromDisk(root)).toBeNull();
  });

  it('型不一致(docCount が文字列)→ null', async () => {
    const root = await makeProject();
    roots.push(root);
    const { metaJson } = mnemothecaPaths(root);
    await fs.promises.writeFile(metaJson, JSON.stringify({ docCount: '7', builtAt: 'x' }));
    expect(await readIndexMetaFromDisk(root)).toBeNull();
  });

  it('GET /api/config が既定でディスクの meta.json を読む(統合)', async () => {
    const root = await makeProject();
    roots.push(root);
    const { metaJson } = mnemothecaPaths(root);
    await fs.promises.writeFile(
      metaJson,
      JSON.stringify({ builtAt: '2026-09-03T00:00:00+09:00', docCount: 3, docs: {} }),
    );
    const app = new Hono().route(
      '/api',
      createConfigRoutes({ projectRoot: root, vaultPath: path.join(root, 'vault'), port: 7777 }),
    );
    const body = (await (await app.request('/api/config')).json()) as ConfigResponse;
    expect(body.noteCount).toBe(3);
    expect(body.indexBuiltAt).toBe('2026-09-03T00:00:00+09:00');
  });
});
