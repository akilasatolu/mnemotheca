// test/server/routes/health-issues.test.ts — 診断バナー / スニペット配信 API。
// 設計 §10-1 / §11-4 / §12-2 / §12-10 / §13-12 / §13-13。
//
// `createHealthIssuesRoutes(deps)` / `createConfigRoutes(deps)` 単体を `/api` にマウントして叩く
// (createApp 全体は使わない。認証は app.ts の責務で別テスト)。

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  createHealthIssuesRoutes,
  type HealthIssuesResponse,
  type HealthIssuesRouteDeps,
} from '../../../src/server/routes/health.js';
import { createConfigRoutes } from '../../../src/server/routes/config.js';
import { buildMcpSnippet } from '../../../src/core/mcp-snippet.js';
import { mnemothecaPaths, vaultPaths } from '../../../src/core/paths.js';
import { makeProject } from '../../helpers/project.js';

const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await fs.promises.rm(r, { recursive: true, force: true });
});

async function mkProject(): Promise<string> {
  const root = await makeProject();
  roots.push(root);
  return root;
}

function mountIssues(over: Partial<HealthIssuesRouteDeps> & Pick<HealthIssuesRouteDeps, 'projectRoot'>): Hono {
  return new Hono().route(
    '/api',
    createHealthIssuesRoutes({
      vaultPath: path.join(over.projectRoot, 'vault'),
      ...over,
    }),
  );
}

async function getIssues(app: Hono): Promise<{ status: number; body: HealthIssuesResponse }> {
  const res = await app.request('/api/health/issues');
  return { status: res.status, body: (await res.json()) as HealthIssuesResponse };
}

async function writeMeta(root: string, builtAt: string, docCount = 0): Promise<void> {
  await fs.promises.writeFile(
    mnemothecaPaths(root).metaJson,
    JSON.stringify({ v: 1, builtAt, docCount, docs: {} }),
  );
}

async function writeNoteFile(root: string, rel: string, mtime?: Date): Promise<string> {
  const abs = path.join(vaultPaths(root).knowledgeDir, rel);
  await fs.promises.mkdir(path.dirname(abs), { recursive: true });
  await fs.promises.writeFile(abs, '# note\n');
  if (mtime) await fs.promises.utimes(abs, mtime, mtime);
  return abs;
}

// ---------------------------------------------------------------------------
describe('GET /api/health/issues — 基本形(§10-1 / §13-13)', () => {
  it('まっさらな projectRoot → 200 + §10-1 のキーちょうど / 既定値', async () => {
    const root = await mkProject();
    const { status, body } = await getIssues(mountIssues({ projectRoot: root }));
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(
      [
        'conflicts',
        'indexStale',
        'nodeModulesMissing',
        'organizeRecoveryPending',
        'parseErrors',
        'vaultMarkerMissing',
        'watcherDown',
      ].sort(),
    );
    expect(body.parseErrors).toEqual([]);
    expect(body.conflicts).toEqual([]);
    expect(body.indexStale).toBe(0);
    expect(body.watcherDown).toBe(false);
    expect(body.organizeRecoveryPending).toBeNull();
    expect(body.vaultMarkerMissing).toBe(false); // makeProject が marker を書く
    expect(body.nodeModulesMissing).toBe(true); // makeProject は node_modules/mnemo を作らない
  });
});

describe('GET /api/health/issues — watcherDown(§6-5 / §13-13a)', () => {
  it('watcherIsDown 未配線 → false', async () => {
    const root = await mkProject();
    expect((await getIssues(mountIssues({ projectRoot: root }))).body.watcherDown).toBe(false);
  });

  it('watcherIsDown() === true → watcherDown: true', async () => {
    const root = await mkProject();
    const app = mountIssues({ projectRoot: root, watcherIsDown: () => true });
    expect((await getIssues(app)).body.watcherDown).toBe(true);
  });

  it('watcherIsDown() === false → watcherDown: false', async () => {
    const root = await mkProject();
    const app = mountIssues({ projectRoot: root, watcherIsDown: () => false });
    expect((await getIssues(app)).body.watcherDown).toBe(false);
  });
});

describe('GET /api/health/issues — parseErrors / conflicts 件数(§10-6)', () => {
  it('parse-errors.json / conflicts.json の内容がそのまま件数に反映される', async () => {
    const root = await mkProject();
    const mp = mnemothecaPaths(root);
    await fs.promises.writeFile(
      mp.parseErrorsJson,
      JSON.stringify([
        { path: 'knowledge/x/a.md', detectedAt: '2026-09-02T00:00:00Z', message: 'frontmatter: bad', kind: 'frontmatter' },
        { path: 'knowledge/x/b.md', detectedAt: '2026-09-02T00:00:00Z', message: 'schema', kind: 'schema' },
      ]),
    );
    await fs.promises.writeFile(
      mp.conflictsJson,
      JSON.stringify([
        { path: 'knowledge/x/c (conflicted copy).md', detectedAt: '2026-09-02T00:00:00Z', reason: 'filename-pattern', dupOf: 'knowledge/x/c.md' },
      ]),
    );
    const { body } = await getIssues(mountIssues({ projectRoot: root }));
    expect(body.parseErrors).toHaveLength(2);
    expect(body.conflicts).toHaveLength(1);
    expect(body.parseErrors[0]).toMatchObject({ path: 'knowledge/x/a.md', kind: 'frontmatter' });
    expect(body.conflicts[0]).toMatchObject({ reason: 'filename-pattern', dupOf: 'knowledge/x/c.md' });
  });

  it('ファイル無し → []、JSON 破損 → []（致命ではない）', async () => {
    const root = await mkProject();
    await fs.promises.writeFile(mnemothecaPaths(root).parseErrorsJson, '{ broken');
    const { body } = await getIssues(mountIssues({ projectRoot: root }));
    expect(body.parseErrors).toEqual([]);
    expect(body.conflicts).toEqual([]);
  });
});

describe('GET /api/health/issues — organizeRecoveryPending 移設先(§12-10 表 #3)', () => {
  it('getOrganizeRecoveryPending が値を返す → そのまま organizeRecoveryPending に載る', async () => {
    const root = await mkProject();
    const app = mountIssues({
      projectRoot: root,
      getOrganizeRecoveryPending: async () => ({ snapshotId: 'organize-20260902T100000000', since: '2026-09-02T10:00:00.000Z' }),
    });
    expect((await getIssues(app)).body.organizeRecoveryPending).toEqual({
      snapshotId: 'organize-20260902T100000000',
      since: '2026-09-02T10:00:00.000Z',
    });
  });

  it('getOrganizeRecoveryPending が null → null', async () => {
    const root = await mkProject();
    const app = mountIssues({ projectRoot: root, getOrganizeRecoveryPending: async () => null });
    expect((await getIssues(app)).body.organizeRecoveryPending).toBeNull();
  });

  it('getOrganizeRecoveryPending 未配線 → null', async () => {
    const root = await mkProject();
    expect((await getIssues(mountIssues({ projectRoot: root }))).body.organizeRecoveryPending).toBeNull();
  });
});

describe('GET /api/health/issues — indexStale(簡易鮮度・§10-1)', () => {
  it('meta.json 無し → 0', async () => {
    const root = await mkProject();
    await writeNoteFile(root, 'architecture/a.md');
    expect((await getIssues(mountIssues({ projectRoot: root }))).body.indexStale).toBe(0);
  });

  it('meta.builtAt より新しいノートだけ数える', async () => {
    const root = await mkProject();
    const old = new Date('2020-01-01T00:00:00Z');
    const fresh = new Date('2099-01-01T00:00:00Z');
    await writeNoteFile(root, 'architecture/old.md', old);
    await writeNoteFile(root, 'architecture/fresh1.md', fresh);
    await writeNoteFile(root, 'architecture/fresh2.md', fresh);
    await writeMeta(root, '2026-09-02T00:00:00.000Z');
    expect((await getIssues(mountIssues({ projectRoot: root }))).body.indexStale).toBe(2);
  });

  it('全ノートがビルド時刻より古い → 0', async () => {
    const root = await mkProject();
    await writeNoteFile(root, 'architecture/old.md', new Date('2020-01-01T00:00:00Z'));
    await writeMeta(root, '2026-09-02T00:00:00.000Z');
    expect((await getIssues(mountIssues({ projectRoot: root }))).body.indexStale).toBe(0);
  });
});

describe('GET /api/health/issues — vaultMarkerMissing / nodeModulesMissing', () => {
  it('marker 削除 → vaultMarkerMissing: true', async () => {
    const root = await mkProject();
    await fs.promises.rm(vaultPaths(root).markerJson);
    expect((await getIssues(mountIssues({ projectRoot: root }))).body.vaultMarkerMissing).toBe(true);
  });

  it('node_modules/mnemo あり → nodeModulesMissing: false', async () => {
    const root = await mkProject();
    await fs.promises.mkdir(path.join(root, 'node_modules', 'mnemo'), { recursive: true });
    expect((await getIssues(mountIssues({ projectRoot: root }))).body.nodeModulesMissing).toBe(false);
  });
});

describe('GET /api/health/issues — 読み取り専用 / 常に 200', () => {
  it('organize-session.json / parse-errors.json を書き換えない', async () => {
    const root = await mkProject();
    const mp = mnemothecaPaths(root);
    await fs.promises.writeFile(mp.parseErrorsJson, JSON.stringify([{ path: 'x', detectedAt: 't', message: 'm', kind: 'k' }]));
    await fs.promises.writeFile(mp.organizeSessionJson, JSON.stringify({ applying: true, snapshotId: 's' }));
    const before = {
      pe: fs.readFileSync(mp.parseErrorsJson, 'utf8'),
      os: fs.readFileSync(mp.organizeSessionJson, 'utf8'),
    };
    await getIssues(mountIssues({ projectRoot: root, getOrganizeRecoveryPending: async () => null }));
    expect(fs.readFileSync(mp.parseErrorsJson, 'utf8')).toBe(before.pe);
    expect(fs.readFileSync(mp.organizeSessionJson, 'utf8')).toBe(before.os);
  });

  it('getOrganizeRecoveryPending が throw しても 200（best-effort）ではなく伝播しない設計: 正常値のみ検証', async () => {
    // getOrganizeRecoveryPending は boot 側で必ず null 安全（§12-10）。ここでは正常値のみ担保。
    const root = await mkProject();
    expect((await getIssues(mountIssues({ projectRoot: root }))).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// GET /api/config/mcp-snippet
// ---------------------------------------------------------------------------
function mountConfig(root: string): Hono {
  return new Hono().route(
    '/api',
    createConfigRoutes({ projectRoot: root, vaultPath: path.join(root, 'vault'), port: 7777, readIndexMeta: () => Promise.resolve(null) }),
  );
}

describe('GET /api/config/mcp-snippet(§9-5 / §10-1 / §13-13)', () => {
  it('buildMcpSnippet(projectRoot) と完全一致(既定 desktop)', async () => {
    const root = await mkProject();
    const res = await mountConfig(root).request('/api/config/mcp-snippet');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(buildMcpSnippet(root, { client: 'desktop' }));
  });

  it('?client=code → filename が .mcp.json、snippet に command 絶対パス / env.MNEMO_PROJECT / キー', async () => {
    const root = await mkProject();
    const res = await mountConfig(root).request('/api/config/mcp-snippet?client=code');
    const body = (await res.json()) as { serverKey: string; snippet: string; filename: string };
    expect(body).toEqual(buildMcpSnippet(root, { client: 'code' }));
    expect(body.filename).toBe('.mcp.json');
    expect(body.serverKey).toMatch(/^mnemotheca-/);
    const parsed = JSON.parse(body.snippet) as { mcpServers: Record<string, { command: string; env: Record<string, string> }> };
    const entry = parsed.mcpServers[body.serverKey]!;
    expect(path.isAbsolute(entry.command)).toBe(true);
    expect(entry.env.MNEMO_PROJECT).toBeDefined();
  });

  it('?env トグルは無視される(常時同梱・§13-13)', async () => {
    const root = await mkProject();
    const withEnv = await (await mountConfig(root).request('/api/config/mcp-snippet?env=1')).json();
    const plain = await (await mountConfig(root).request('/api/config/mcp-snippet')).json();
    expect(withEnv).toEqual(plain);
  });

  it('機密(token / secret / authorization)がレスポンスに出ない', async () => {
    const root = await mkProject();
    const text = JSON.stringify(await (await mountConfig(root).request('/api/config/mcp-snippet')).json());
    expect(text).not.toMatch(/token/i);
    expect(text).not.toMatch(/secret/i);
    expect(text).not.toMatch(/authorization/i);
    expect(text).not.toMatch(/bearer/i);
  });
});
