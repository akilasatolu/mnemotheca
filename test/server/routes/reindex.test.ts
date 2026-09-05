// test/server/routes/reindex.test.ts — 設計 §10-1 / §6-5 / §6-6 / §13-13。
//
// `createReindexRoutes` / `createEventsRoutes` を `createApp` にマウントし `app.request()` で叩く
// (認証は app.ts の責務。§13-13 の `?t=` 例外もここで併せて検証する)。

import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Frontmatter } from '../../../src/core/frontmatter.js';
import { noteAbsPathForCategory, noteRelPath, writeNote } from '../../../src/core/note.js';
import { buildIndex, loadIndex, type IndexHandle } from '../../../src/core/search.js';
import { createApp } from '../../../src/server/app.js';
import {
  createReindexRoutes,
  validateReindexPaths,
  type ReindexResponse,
  type ReindexRoutesDeps,
} from '../../../src/server/routes/reindex.js';
import {
  createEventsRoutes,
  type EventsRoutesDeps,
  type IndexEventPayload,
} from '../../../src/server/routes/events.js';
import { makeProject } from '../../helpers/project.js';

const TOKEN = 'test-reindex-token';
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const d = roots.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

async function mkProject(): Promise<string> {
  const root = await makeProject();
  roots.push(root);
  return root;
}

let idCounter = 0;
function fm(overrides: Partial<Frontmatter> = {}): Frontmatter {
  idCounter += 1;
  return {
    id: `20260901T093015${String(idCounter).padStart(3, '0')}ab`,
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

async function addNote(root: string, slug: string, body = '本文テキスト'): Promise<string> {
  const abs = noteAbsPathForCategory(root, 'architecture', slug);
  await writeNote(abs, fm(), body);
  return noteRelPath(root, abs);
}

/** インメモリのインデックス更新エミッタ(watcher の代役)。 */
function makeEmitter() {
  const listeners = new Set<(p: IndexEventPayload) => void>();
  return {
    subscribe: (cb: (p: IndexEventPayload) => void): (() => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    emit: (p: IndexEventPayload): void => {
      for (const cb of [...listeners]) cb(p);
    },
    count: (): number => listeners.size,
  };
}

function mountApp(
  root: string,
  opts: { reindex?: Partial<ReindexRoutesDeps>; events?: Partial<EventsRoutesDeps> } = {},
): Hono {
  const reindexDeps: ReindexRoutesDeps = {
    projectRoot: root,
    getIndex: () => loadIndex(root),
    ...opts.reindex,
  };
  const eventsDeps: EventsRoutesDeps = {
    token: TOKEN,
    subscribe: () => () => undefined,
    keepaliveMs: 0,
    ...opts.events,
  };
  const api = new Hono();
  api.route('/', createReindexRoutes(reindexDeps));
  api.route('/', createEventsRoutes(eventsDeps));
  return createApp(
    { projectRoot: root, token: TOKEN, port: 4711, startedAt: new Date().toISOString() },
    api,
  );
}

function postReindex(app: Hono, body: unknown, token: string | null = TOKEN): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return Promise.resolve(
    app.request('/api/reindex', { method: 'POST', headers, body: JSON.stringify(body) }),
  );
}

/** SSE 本文を needle が現れるか ms 経過まで読む。 */
async function readUntil(res: Response, needle: string, ms: number): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const timer = setTimeout(() => void reader.cancel(), ms);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) buf += dec.decode(value, { stream: true });
      if (buf.includes(needle)) break;
    }
  } catch {
    /* cancelled */
  }
  clearTimeout(timer);
  try {
    await reader.cancel();
  } catch {
    /* already closed */
  }
  return buf;
}

// ---------------------------------------------------------------------------
// validateReindexPaths(純関数)
// ---------------------------------------------------------------------------

describe('validateReindexPaths(§10-1 バリデーション)', () => {
  it('knowledge/ 配下の相対パスを正規化して通す', () => {
    const v = validateReindexPaths(['knowledge/architecture/a.md', 'knowledge/b.md']);
    expect(v).toEqual({ ok: true, paths: ['knowledge/architecture/a.md', 'knowledge/b.md'] });
  });

  it('`..` を含むパストラバーサルを弾く', () => {
    expect(validateReindexPaths(['../../etc/passwd']).ok).toBe(false);
    expect(validateReindexPaths(['knowledge/../../secret']).ok).toBe(false);
  });

  it('絶対パス(POSIX / Windows)を弾く', () => {
    expect(validateReindexPaths(['/etc/passwd']).ok).toBe(false);
    expect(validateReindexPaths(['C:\\Windows\\x']).ok).toBe(false);
  });

  it('knowledge/ の外を弾く', () => {
    expect(validateReindexPaths(['categories/architecture.md']).ok).toBe(false);
    expect(validateReindexPaths(['.mnemotheca/index/meta.json']).ok).toBe(false);
  });

  it('配列でない / 空文字列 / NUL を弾く', () => {
    expect(validateReindexPaths('knowledge/a.md').ok).toBe(false);
    expect(validateReindexPaths(['']).ok).toBe(false);
    expect(validateReindexPaths(['knowledge/a\0.md']).ok).toBe(false);
  });

  it('1 件でも違反があれば全体を拒否する', () => {
    expect(validateReindexPaths(['knowledge/ok.md', '../evil']).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// POST /api/reindex
// ---------------------------------------------------------------------------

describe('POST /api/reindex(§10-1 / §6-6 / §13-13)', () => {
  it('paths にトラバーサルを含むと 400 + 共通エラー形式で全体拒否', async () => {
    const root = await mkProject();
    await buildIndex(root);
    const app = mountApp(root);
    const res = await postReindex(app, { paths: ['knowledge/a.md', '../../etc/passwd'] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('INVALID_PATH');
    expect(typeof body.error.message).toBe('string');
  });

  it('絶対パス / knowledge 外の paths も 400', async () => {
    const root = await mkProject();
    await buildIndex(root);
    const app = mountApp(root);
    expect((await postReindex(app, { paths: ['/etc/passwd'] })).status).toBe(400);
    expect((await postReindex(app, { paths: ['categories/x.md'] })).status).toBe(400);
  });

  it('full:true → buildIndex を呼び { added, updated, removed, tookMs } を返す', async () => {
    const root = await mkProject();
    await addNote(root, 'note-a');
    await addNote(root, 'note-b');
    const app = mountApp(root);

    const res = await postReindex(app, { full: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReindexResponse;
    expect(body).toMatchObject({ added: 2, updated: 0, removed: 0 });
    expect(typeof body.tookMs).toBe('number');
    expect(body.tookMs).toBeGreaterThanOrEqual(0);
  });

  it('full:true の onRebuilt フックに新ハンドルが渡る', async () => {
    const root = await mkProject();
    await addNote(root, 'note-a');
    let rebuilt: IndexHandle | null = null;
    const app = mountApp(root, { reindex: { onRebuilt: (h) => (rebuilt = h) } });
    await postReindex(app, { full: true });
    expect(rebuilt).not.toBeNull();
    expect(rebuilt!.meta.docCount).toBe(1);
  });

  it('paths 指定 → 指定ファイルだけ差分適用し件数を返す(add / update / remove)', async () => {
    const root = await mkProject();
    const relA = await addNote(root, 'note-a', 'アルファ');
    const handle = await buildIndex(root); // ライブハンドルとして共有
    const app = mountApp(root, { reindex: { getIndex: () => Promise.resolve(handle) } });

    // 新規ファイルを追加 → paths でそれだけ取り込む
    const relB = await addNote(root, 'note-b', 'ブラボー');
    const addRes = (await (await postReindex(app, { paths: [relB] })).json()) as ReindexResponse;
    expect(addRes).toMatchObject({ added: 1, updated: 0, removed: 0 });
    expect(handle.meta.docs[relB]).toBeDefined();

    // 既存ファイルを更新 → updated
    await new Promise((r) => setTimeout(r, 5));
    await writeNote(
      noteAbsPathForCategory(root, 'architecture', 'note-a'),
      fm(),
      'アルファ更新済み',
    );
    const updRes = (await (await postReindex(app, { paths: [relA] })).json()) as ReindexResponse;
    expect(updRes).toMatchObject({ added: 0, updated: 1, removed: 0 });

    // ファイル削除 → removed
    await fs.promises.rm(noteAbsPathForCategory(root, 'architecture', 'note-b'));
    const rmRes = (await (await postReindex(app, { paths: [relB] })).json()) as ReindexResponse;
    expect(rmRes).toMatchObject({ added: 0, updated: 0, removed: 1 });
    expect(handle.meta.docs[relB]).toBeUndefined();
  });

  it('paths 省略 → syncIndex で全差分を取り込む', async () => {
    const root = await mkProject();
    const handle = await buildIndex(root); // 空
    const app = mountApp(root, { reindex: { getIndex: () => Promise.resolve(handle) } });

    await addNote(root, 'note-a');
    await addNote(root, 'note-b');
    const res = (await (await postReindex(app, {})).json()) as ReindexResponse;
    expect(res).toMatchObject({ added: 2, updated: 0, removed: 0 });
  });

  it('Bearer トークンが無ければ 401(app.ts の認証)', async () => {
    const root = await mkProject();
    const app = mountApp(root);
    const res = await postReindex(app, { full: true }, null);
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /api/events(SSE)
// ---------------------------------------------------------------------------

describe('GET /api/events(SSE。§10-1 認証節 / §6-5 / §13-13)', () => {
  it('?t 欠落 → 401(通常レスポンス)', async () => {
    const root = await mkProject();
    const app = mountApp(root);
    const res = await app.request('/api/events');
    expect(res.status).toBe(401);
    expect(res.headers.get('Content-Type')).toContain('application/json');
  });

  it('?t 不一致 → 401', async () => {
    const root = await mkProject();
    const app = mountApp(root);
    const res = await app.request('/api/events?t=wrong-token');
    expect(res.status).toBe(401);
  });

  it('?t 一致 → 200 + text/event-stream で接続、watcher イベントで index-updated を受信', async () => {
    const root = await mkProject();
    const emitter = makeEmitter();
    const app = mountApp(root, { events: { subscribe: emitter.subscribe } });

    const res = await app.request(`/api/events?t=${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');

    await new Promise((r) => setTimeout(r, 30));
    expect(emitter.count()).toBe(1);
    emitter.emit({ type: 'index-updated', changed: 3 });

    const buf = await readUntil(res, 'index-updated', 1000);
    expect(buf).toContain('data: {"type":"index-updated","changed":3}');
  });

  it('クライアント切断で購読解除される', async () => {
    const root = await mkProject();
    const emitter = makeEmitter();
    const app = mountApp(root, { events: { subscribe: emitter.subscribe } });

    const res = await app.request(`/api/events?t=${TOKEN}`);
    await new Promise((r) => setTimeout(r, 30));
    expect(emitter.count()).toBe(1);

    await res.body!.cancel();
    await new Promise((r) => setTimeout(r, 60));
    expect(emitter.count()).toBe(0);
  });

  it('Authorization ヘッダ経路でも接続できる', async () => {
    const root = await mkProject();
    const emitter = makeEmitter();
    const app = mountApp(root, { events: { subscribe: emitter.subscribe } });
    const res = await app.request('/api/events', { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    await res.body!.cancel();
  });

  it('createEventsRoutes 単体(app.ts 非経由)でも ?t 認証する', async () => {
    const r = createEventsRoutes({
      token: TOKEN,
      subscribe: () => () => undefined,
      keepaliveMs: 0,
    });
    expect((await r.request('/events')).status).toBe(401);
    expect((await r.request('/events?t=wrong')).status).toBe(401);
  });
});
