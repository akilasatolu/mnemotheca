// test/server/mount.test.ts — server/mount.ts + boot/app 結線(設計 §10-1 / §9-6 / §12-10)。
//
// - `mountApiRoutes` が 8 ルート群(healthz + /api 直下 7)を過不足なくマウントする。
// - `/healthz` は単一実装・7 キー固定(app.ts の重複を createHealthRoutes に一本化)。
// - `startServer` 起動後、`/api/notes` `/api/search` `POST /api/reindex` `/api/events?t=` が疎通。
// - watcher の `index-updated` が SSE に流れる。
// - `POST /api/reindex {full:true}` 後、live ハンドルが差し替わる(getIndex が新ハンドルを返す)。
// - `organize-session.json` の `applying:true` 残存時に `/api/health/issues.organizeRecoveryPending` が非 null。

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Frontmatter } from '../../src/core/frontmatter.js';
import { noteAbsPathForCategory, writeNote } from '../../src/core/note.js';
import { buildIndex, type IndexHandle } from '../../src/core/search.js';
import { mnemothecaPaths, runtimePaths } from '../../src/core/paths.js';
import { createApp } from '../../src/server/app.js';
import { mountApiRoutes, healthDepsFrom, type MountApiRoutesDeps } from '../../src/server/mount.js';
import { startServer, type BootDeps, type StartedServer } from '../../src/server/boot.js';
import type { IndexEventPayload } from '../../src/server/routes/events.js';
import type { IndexUpdatedPayload } from '../../src/server/watcher.js';
import { makeProject } from '../helpers/project.js';

const TOKEN = 'mount-test-token-xyz';
const auth = { Authorization: `Bearer ${TOKEN}` };
const roots: string[] = [];
const servers: StartedServer[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) {
    try {
      await s.stop();
    } catch {
      /* noop */
    }
  }
  for (const root of roots.splice(0)) {
    try {
      fs.rmSync(runtimePaths(root).dir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

async function mkProject(): Promise<string> {
  const root = await makeProject();
  roots.push(root);
  return root;
}

let idc = 0;
function fm(overrides: Partial<Frontmatter> = {}): Frontmatter {
  idc += 1;
  return {
    id: `20260901T0930150${String(idc).padStart(2, '0')}ab`,
    title: 'タイトル',
    categories: ['architecture'],
    tags: ['aws'],
    created: '2026-09-01T09:30:15+09:00',
    updated: '2026-09-01T09:30:15+09:00',
    summary: '要約テキスト',
    source: 'claude-desktop',
    ...overrides,
  };
}

async function addNote(root: string, slug: string, body = 'これは検索対象の本文テキストです'): Promise<void> {
  await writeNote(noteAbsPathForCategory(root, 'architecture', slug), fm(), body);
}

function baseMountDeps(root: string, over: Partial<MountApiRoutesDeps> = {}): MountApiRoutesDeps {
  return {
    projectRoot: root,
    vaultPath: path.join(root, 'vault'),
    port: 7777,
    startedAt: '2026-09-03T00:00:00.000Z',
    version: '9.9.9',
    token: TOKEN,
    getIndex: () => buildIndex(root),
    subscribe: () => () => undefined,
    ...over,
  };
}

function appWith(root: string, over: Partial<MountApiRoutesDeps> = {}) {
  const deps = baseMountDeps(root, over);
  return createApp(
    { projectRoot: root, token: TOKEN, port: 7777, startedAt: '2026-09-03T00:00:00.000Z', version: '9.9.9' },
    mountApiRoutes(deps),
  );
}

// ---------------------------------------------------------------------------
describe('mountApiRoutes — 8 ルート群を過不足なくマウント', () => {
  it('代表エンドポイントがすべて 404 でない', async () => {
    const root = await mkProject();
    await addNote(root, 'note-a');
    const app = appWith(root);

    const healthz = await app.request('/healthz');
    expect(healthz.status).toBe(200);

    const config = await app.request('/api/config', { headers: auth });
    expect(config.status).toBe(200);

    const notes = await app.request('/api/notes', { headers: auth });
    expect(notes.status).toBe(200);

    const categories = await app.request('/api/categories', { headers: auth });
    expect(categories.status).toBe(200);

    const search = await app.request('/api/search?q=' + encodeURIComponent('本文'), { headers: auth });
    expect(search.status).toBe(200);

    const dashboard = await app.request('/api/dashboard', { headers: auth });
    expect(dashboard.status).toBe(200);

    const reindex = await app.request('/api/reindex', { method: 'POST', headers: auth });
    expect(reindex.status).toBe(200);

    const events = await app.request('/api/events?t=' + TOKEN);
    expect(events.status).toBe(200);
    expect(events.headers.get('Content-Type')).toContain('text/event-stream');

    const issues = await app.request('/api/health/issues', { headers: auth });
    expect(issues.status).toBe(200);

    const snippet = await app.request('/api/config/mcp-snippet', { headers: auth });
    expect(snippet.status).toBe(200);

    // 未定義 /api パスは従来どおり 404(結線でフォールスルーが壊れていない)。
    const missing = await app.request('/api/nope', { headers: auth });
    expect(missing.status).toBe(404);
  });

  it('認証は app.ts が担当(/api/* はトークン無しで 401、/healthz は無認証)', async () => {
    const root = await mkProject();
    const app = appWith(root);
    expect((await app.request('/api/notes')).status).toBe(401);
    expect((await app.request('/healthz')).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
describe('/healthz — 単一実装・7 キー固定', () => {
  it('createApp 経由の /healthz が設計 §10-1 の 7 キーちょうど', async () => {
    const root = await mkProject();
    const app = appWith(root);
    const res = await app.request('/healthz');
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      ['name', 'ok', 'port', 'projectRoot', 'startedAt', 'vaultPath', 'version'].sort(),
    );
    expect(body).toEqual({
      ok: true,
      name: 'mnemotheca',
      version: '9.9.9',
      projectRoot: root,
      vaultPath: path.join(root, 'vault'),
      port: 7777,
      startedAt: '2026-09-03T00:00:00.000Z',
    });
  });

  it('healthDepsFrom は 5 キーだけを抜き出す', () => {
    const d = healthDepsFrom({
      projectRoot: '/p',
      vaultPath: '/p/vault',
      port: 1,
      startedAt: 's',
      version: 'v',
    });
    expect(d).toEqual({ projectRoot: '/p', vaultPath: '/p/vault', port: 1, startedAt: 's', version: 'v' });
  });
});

// ---------------------------------------------------------------------------
describe('mountApiRoutes — organizeRecoveryPending は /api/health/issues(§12-10)', () => {
  it('applying:true 残存 → /api/health/issues.organizeRecoveryPending が {snapshotId, since}', async () => {
    const root = await mkProject();
    const app = appWith(root, {
      getOrganizeRecoveryPending: async () => ({ snapshotId: 'organize-20260901T000000000', since: '2026-09-01T00:00:00.000Z' }),
    });
    const res = await app.request('/api/health/issues', { headers: auth });
    const body = (await res.json()) as { organizeRecoveryPending: unknown };
    expect(body.organizeRecoveryPending).toEqual({
      snapshotId: 'organize-20260901T000000000',
      since: '2026-09-01T00:00:00.000Z',
    });
  });

  it('中断なし → organizeRecoveryPending: null', async () => {
    const root = await mkProject();
    const app = appWith(root, { getOrganizeRecoveryPending: async () => null });
    const res = await app.request('/api/health/issues', { headers: auth });
    expect((await res.json() as { organizeRecoveryPending: unknown }).organizeRecoveryPending).toBeNull();
  });

  it('/api/config には organizeRecoveryPending を一切上乗せしない(撤去確認)', async () => {
    const root = await mkProject();
    const app = appWith(root, {
      getOrganizeRecoveryPending: async () => ({ snapshotId: 's', since: 't' }),
    });
    const res = await app.request('/api/config', { headers: auth });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('organizeRecoveryPending');
    expect(Object.keys(body).sort()).toEqual(
      ['indexBuiltAt', 'noteCount', 'projectRoot', 'serverPort', 'vaultPath'].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// boot 結線
// ---------------------------------------------------------------------------

interface FakeServer {
  close: ReturnType<typeof vi.fn>;
}

function bootDeps(over: Partial<BootDeps> = {}): {
  deps: Partial<BootDeps>;
  captured: { fetch?: (req: Request) => Response | Promise<Response> };
  watcherCb: { current?: (p: IndexUpdatedPayload) => void };
} {
  const server: FakeServer = { close: vi.fn((cb?: () => void) => cb?.()) };
  const captured: { fetch?: (req: Request) => Response | Promise<Response> } = {};
  const serve = vi.fn((opts: { fetch: (req: Request) => Response | Promise<Response> }) => {
    captured.fetch = opts.fetch;
    return server;
  });
  const watcherCb: { current?: (p: IndexUpdatedPayload) => void } = {};
  const watcher = {
    close: vi.fn(async () => undefined),
    onIndexUpdated: vi.fn((cb: (p: IndexUpdatedPayload) => void) => {
      watcherCb.current = cb;
      return () => undefined;
    }),
    isDown: vi.fn(() => false),
    isPolling: vi.fn(() => false),
  };
  const deps: Partial<BootDeps> = {
    serve: serve as unknown as BootDeps['serve'],
    createWatcher: vi.fn(() => watcher) as unknown as BootDeps['createWatcher'],
    repairUsageTail: vi.fn(async () => ({ trimmed: false })) as unknown as BootDeps['repairUsageTail'],
    isPortFree: vi.fn(async () => true),
    probeHealthz: vi.fn(async () => false),
    isPidAlive: vi.fn(() => true),
    now: () => new Date('2026-09-03T00:00:00.000Z'),
    pid: 4242,
    version: '9.9.9',
    selfCheckIntervalMs: 30_000,
    exit: vi.fn(),
    logger: vi.fn(),
    ...over,
  };
  return { deps, captured, watcherCb };
}

async function readSSE(res: Response, ms = 1500): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let out = '';
  const deadline = Date.now() + ms;
  try {
    while (Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((r) => setTimeout(() => r({ done: true, value: undefined }), 200)),
      ]);
      if (chunk.value) out += dec.decode(chunk.value, { stream: true });
      if (chunk.done && !chunk.value) {
        if (out.includes('index-updated')) break;
      }
      if (out.includes('index-updated')) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return out;
}

describe('startServer — /api 結線疎通(§9-6 / §13-16 の単体切り出し)', () => {
  it('起動後 /api/notes・/api/search・POST /api/reindex・/api/events?t= が疎通', async () => {
    const root = await mkProject();
    await addNote(root, 'boot-note', '機械学習の応用に関する本文');
    const { deps, captured } = bootDeps();
    const s = await startServer({ projectRoot: root, detached: true, deps });
    servers.push(s);
    const h = { Authorization: `Bearer ${s.token}` };
    const call = (p: string, init?: RequestInit): Promise<Response> =>
      Promise.resolve(captured.fetch!(new Request('http://127.0.0.1' + p, init)));

    expect((await call('/healthz')).status).toBe(200);
    expect((await call('/api/notes', { headers: h })).status).toBe(200);

    const search = await call('/api/search?q=' + encodeURIComponent('本文'), { headers: h });
    expect(search.status).toBe(200);
    expect(((await search.json()) as { total: number }).total).toBeGreaterThanOrEqual(1);

    const reindex = await call('/api/reindex', { method: 'POST', headers: h });
    expect(reindex.status).toBe(200);

    const events = await call('/api/events?t=' + s.token);
    expect(events.status).toBe(200);
    await events.body?.cancel().catch(() => undefined);

    const eventsBad = await call('/api/events?t=wrong');
    expect(eventsBad.status).toBe(401);
  });

  it('watcher の index-updated が SSE(/api/events)に流れる', async () => {
    const root = await mkProject();
    await addNote(root, 'sse-note');
    const { deps, captured, watcherCb } = bootDeps();
    const s = await startServer({ projectRoot: root, detached: true, deps });
    servers.push(s);

    expect(typeof watcherCb.current).toBe('function');

    const res = await Promise.resolve(
      captured.fetch!(new Request('http://127.0.0.1/api/events?t=' + s.token)),
    );
    expect(res.status).toBe(200);

    const collected = readSSE(res);
    await new Promise((r) => setTimeout(r, 50));
    watcherCb.current!({ type: 'index-updated', changed: 3 });

    const text = await collected;
    expect(text).toContain('index-updated');
    const line = text.split('\n').find((l) => l.startsWith('data:'));
    expect(line).toBeDefined();
    expect(JSON.parse(line!.slice('data:'.length).trim())).toEqual({ type: 'index-updated', changed: 3 });
  });

  it('POST /api/reindex {full:true} 後、live ハンドルが差し替わる(getIndex が新ハンドル)', async () => {
    const root = await mkProject();
    await addNote(root, 'first');
    const { deps, captured } = bootDeps();
    const s = await startServer({ projectRoot: root, detached: true, deps });
    servers.push(s);
    const auth2 = { Authorization: `Bearer ${s.token}` };
    const call = (p: string, init?: RequestInit): Promise<Response> =>
      Promise.resolve(captured.fetch!(new Request('http://127.0.0.1' + p, init)));

    const before = (await (await call('/api/config', { headers: auth2 })).json()) as { noteCount: number };
    expect(before.noteCount).toBe(1);

    // ディスクに 2 件目を追加し、full 再構築を要求。
    await addNote(root, 'second');
    const rebuilt = await call('/api/reindex', {
      method: 'POST',
      headers: { ...auth2, 'Content-Type': 'application/json' },
      body: JSON.stringify({ full: true }),
    });
    expect(rebuilt.status).toBe(200);

    // onRebuilt で live ハンドルが差し替わったので config の noteCount(= liveHandle.meta.docCount)が増える。
    const after = (await (await call('/api/config', { headers: auth2 })).json()) as { noteCount: number };
    expect(after.noteCount).toBe(2);
  });
});

describe('startServer — organizeRecoveryPending(§12-10 表 #3: 読み取り専用)', () => {
  async function writeSession(root: string, obj: Record<string, unknown>): Promise<void> {
    const file = mnemothecaPaths(root).organizeSessionJson;
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, JSON.stringify(obj), 'utf8');
  }

  async function configOf(root: string): Promise<{ organizeRecoveryPending: unknown }> {
    const { deps, captured } = bootDeps();
    const s = await startServer({ projectRoot: root, detached: true, deps });
    servers.push(s);
    const res = await Promise.resolve(
      captured.fetch!(new Request('http://127.0.0.1/api/health/issues', { headers: { Authorization: `Bearer ${s.token}` } })),
    );
    return (await res.json()) as { organizeRecoveryPending: unknown };
  }

  it('applying:true 且つ未失効 → {snapshotId, since}、ファイルは書き換えない', async () => {
    const root = await mkProject();
    await writeSession(root, {
      v: 1,
      sessionId: 'org-x',
      scannedAt: '2026-09-02T10:00:00.000Z',
      proposals: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
      applying: true,
      snapshotId: 'organize-20260902T100000000',
    });
    const file = mnemothecaPaths(root).organizeSessionJson;
    const before = fs.readFileSync(file, 'utf8');

    const body = await configOf(root);
    expect(body.organizeRecoveryPending).toEqual({
      snapshotId: 'organize-20260902T100000000',
      since: '2026-09-02T10:00:00.000Z',
    });
    expect(fs.readFileSync(file, 'utf8')).toBe(before); // 読み取り専用
  });

  it('applying:false → null', async () => {
    const root = await mkProject();
    await writeSession(root, {
      v: 1,
      sessionId: 'org-x',
      scannedAt: '2026-09-02T10:00:00.000Z',
      proposals: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
      applying: false,
      snapshotId: null,
    });
    expect((await configOf(root)).organizeRecoveryPending).toBeNull();
  });

  it('applying:true だが失効済み → null', async () => {
    const root = await mkProject();
    await writeSession(root, {
      v: 1,
      sessionId: 'org-x',
      scannedAt: '2020-01-01T00:00:00.000Z',
      proposals: [],
      expiresAt: '2020-01-02T00:00:00.000Z',
      applying: true,
      snapshotId: 'organize-old',
    });
    expect((await configOf(root)).organizeRecoveryPending).toBeNull();
  });

  it('organize-session.json 無し → null', async () => {
    const root = await mkProject();
    expect((await configOf(root)).organizeRecoveryPending).toBeNull();
  });

  it('JSON 破損 → null(退避もしない)', async () => {
    const root = await mkProject();
    const file = mnemothecaPaths(root).organizeSessionJson;
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, '{ broken', 'utf8');
    expect((await configOf(root)).organizeRecoveryPending).toBeNull();
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readdirSync(path.dirname(file)).some((f) => f.includes('corrupt'))).toBe(false);
  });
});
