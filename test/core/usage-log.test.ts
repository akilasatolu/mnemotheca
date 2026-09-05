import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  aggregateUsage,
  appendUsage,
  readUsage,
  repairUsageTail,
  type UsageRecord,
} from '../../src/core/usage-log.js';
import { mnemothecaPaths } from '../../src/core/paths.js';
import { makeProject } from '../helpers/project.js';

const roots: string[] = [];

async function mkProject(): Promise<string> {
  const root = fs.realpathSync.native(await makeProject());
  roots.push(root);
  return root;
}

function logPath(root: string): string {
  return mnemothecaPaths(root).usageLogJsonl;
}

function readLines(root: string): string[] {
  return fs
    .readFileSync(logPath(root), 'utf8')
    .split('\n')
    .filter((l) => l !== '');
}

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});

const rec = (over: Partial<Omit<UsageRecord, 'v'>> = {}): Omit<UsageRecord, 'v'> => ({
  ts: '2026-09-01T10:00:00.000Z',
  mode: 'store',
  event: 'store.apply',
  ok: true,
  ...over,
});

describe('appendUsage', () => {
  it('appends one JSON line terminated by a newline, with v:1', async () => {
    const root = await mkProject();
    await appendUsage(root, rec({ count: 2, approxChars: 1234 }));

    const raw = fs.readFileSync(logPath(root), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);

    const lines = readLines(root);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as UsageRecord;
    expect(parsed.v).toBe(1);
    expect(parsed.mode).toBe('store');
    expect(parsed.count).toBe(2);
    expect(parsed.approxChars).toBe(1234);
  });

  it('creates the index directory if missing', async () => {
    const root = await mkProject();
    fs.rmSync(mnemothecaPaths(root).indexDir, { recursive: true, force: true });

    await appendUsage(root, rec());
    expect(fs.existsSync(logPath(root))).toBe(true);
  });

  it('never stores note bodies — only the whitelisted fields', async () => {
    const root = await mkProject();
    await appendUsage(root, rec({ approxChars: 500, categories: ['tech'], paths: ['knowledge/tech/a.md'] }));
    const parsed = JSON.parse(readLines(root)[0]!) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(
      ['approxChars', 'categories', 'event', 'mode', 'ok', 'paths', 'ts', 'v'].sort(),
    );
    expect('content' in parsed).toBe(false);
    expect('body' in parsed).toBe(false);
  });

  it('records the reindex mode/event', async () => {
    const root = await mkProject();
    await appendUsage(root, { ts: '2026-09-02T00:00:00.000Z', mode: 'reindex', event: 'reindex', ok: true, count: 7 });
    const parsed = JSON.parse(readLines(root)[0]!) as UsageRecord;
    expect(parsed.mode).toBe('reindex');
    expect(parsed.event).toBe('reindex');
    expect(parsed.count).toBe(7);
  });

  it('serializes 20 concurrent appends into 20 intact lines (lock)', async () => {
    const root = await mkProject();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        appendUsage(root, rec({ ts: `2026-09-01T10:00:${String(i).padStart(2, '0')}.000Z`, count: i })),
      ),
    );

    const lines = readLines(root);
    expect(lines).toHaveLength(20);
    const counts = lines.map((l) => (JSON.parse(l) as UsageRecord).count).sort((a, b) => Number(a) - Number(b));
    expect(counts).toEqual(Array.from({ length: 20 }, (_, i) => i));
  }, 30_000);

  it('swallows write failures (history is best-effort, upstream must not fail)', async () => {
    const root = await mkProject();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const appendSpy = vi
      .spyOn(fs.promises, 'appendFile')
      .mockRejectedValue(new Error('ENOSPC: no space left on device'));

    await expect(appendUsage(root, rec())).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
    appendSpy.mockRestore();
  });
});

describe('readUsage', () => {
  it('returns empty result when the file does not exist', async () => {
    const root = await mkProject();
    await expect(readUsage(root)).resolves.toEqual({ records: [], skipped: 0 });
  });

  it('reads one record per line and skips malformed / non-object lines', async () => {
    const root = await mkProject();
    const good1 = JSON.stringify({ v: 1, ...rec({ count: 1 }) });
    const good2 = JSON.stringify({ v: 1, ...rec({ count: 2 }) });
    fs.mkdirSync(mnemothecaPaths(root).indexDir, { recursive: true });
    fs.writeFileSync(
      logPath(root),
      `${good1}\n{ this is not json \n${good2}\n[1,2,3]\n"a string"\n\n`,
    );

    const { records, skipped } = await readUsage(root);
    expect(records.map((r) => r.count)).toEqual([1, 2]);
    expect(skipped).toBe(3); // broken json + array + bare string ; empty line ignored, not counted
  });

  it('retires a wholly unreadable log to .corrupt-<ts> and returns an empty log', async () => {
    const root = await mkProject();
    // Simulate "全損": a directory where the log file should be -> readFile throws EISDIR.
    fs.mkdirSync(logPath(root), { recursive: true });

    const { records, skipped } = await readUsage(root);
    expect(records).toEqual([]);
    expect(skipped).toBe(0);

    const retired = fs
      .readdirSync(mnemothecaPaths(root).indexDir)
      .filter((n) => n.startsWith('usage_log.jsonl.corrupt-'));
    expect(retired).toHaveLength(1);
    expect(fs.existsSync(logPath(root))).toBe(false);
  });
});

describe('repairUsageTail', () => {
  it('does nothing when the file is missing', async () => {
    const root = await mkProject();
    await expect(repairUsageTail(root)).resolves.toEqual({ trimmed: false });
  });

  it('does nothing when the file ends with a newline (clean termination)', async () => {
    const root = await mkProject();
    await appendUsage(root, rec({ count: 1 }));
    await appendUsage(root, rec({ count: 2 }));
    const before = fs.readFileSync(logPath(root), 'utf8');

    await expect(repairUsageTail(root)).resolves.toEqual({ trimmed: false });
    expect(fs.readFileSync(logPath(root), 'utf8')).toBe(before);
  });

  it('trims a torn trailing line (process crash mid-write) but keeps whole lines', async () => {
    const root = await mkProject();
    const whole = JSON.stringify({ v: 1, ...rec({ count: 1 }) });
    fs.mkdirSync(mnemothecaPaths(root).indexDir, { recursive: true });
    // second line was cut off by a crash: no trailing newline, truncated JSON
    fs.writeFileSync(logPath(root), `${whole}\n{"v":1,"ts":"2026-09-01T10:00:01`);

    await expect(repairUsageTail(root)).resolves.toEqual({ trimmed: true });

    const { records, skipped } = await readUsage(root);
    expect(skipped).toBe(0);
    expect(records.map((r) => r.count)).toEqual([1]);
    expect(fs.readFileSync(logPath(root), 'utf8')).toBe(`${whole}\n`);
  });

  it('truncates to empty when the only line is incomplete (no newline at all)', async () => {
    const root = await mkProject();
    fs.mkdirSync(mnemothecaPaths(root).indexDir, { recursive: true });
    fs.writeFileSync(logPath(root), '{"v":1,"ts":"2026-09');

    await expect(repairUsageTail(root)).resolves.toEqual({ trimmed: true });
    expect(fs.readFileSync(logPath(root), 'utf8')).toBe('');
  });

  it('recovers a crash-truncated jsonl end-to-end (repair then read)', async () => {
    const root = await mkProject();
    await appendUsage(root, rec({ ts: '2026-09-01T10:00:00.000Z', count: 1 }));
    await appendUsage(root, rec({ ts: '2026-09-01T10:00:01.000Z', count: 2 }));
    await appendUsage(root, rec({ ts: '2026-09-01T10:00:02.000Z', count: 3 }));

    // emulate a crash appending a 4th record: partial bytes, no newline
    fs.appendFileSync(logPath(root), '{"v":1,"ts":"2026-09-01T10:00:03.000Z","mode":"sto');

    // before repair: the torn line is skipped by the reader
    const dirty = await readUsage(root);
    expect(dirty.records.map((r) => r.count)).toEqual([1, 2, 3]);
    expect(dirty.skipped).toBe(1);

    // after repair: clean, no skipped lines, and further appends line up correctly
    await repairUsageTail(root);
    await appendUsage(root, rec({ ts: '2026-09-01T10:00:04.000Z', count: 4 }));

    const clean = await readUsage(root);
    expect(clean.skipped).toBe(0);
    expect(clean.records.map((r) => r.count)).toEqual([1, 2, 3, 4]);
  });
});

describe('aggregateUsage', () => {
  it('returns all-zero stats for empty input', async () => {
    const stats = await aggregateUsage([]);
    expect(stats).toEqual({
      range: { from: '', to: '' },
      totals: { store: 0, organize: 0, show: 0, notesCreated: 0, notesDeleted: 0 },
      storeCountByDay: [],
      notesByCategory: [],
      modeCountByMonth: [],
      lastUsedAt: { store: null, organize: null, show: null },
      skippedLogLines: 0,
    });
  });

  it('computes totals, ranges, per-day, per-category, per-month and last-used values', async () => {
    const records: UsageRecord[] = [
      { v: 1, ts: '2026-07-10T09:00:00.000Z', mode: 'store', event: 'store.apply', ok: true, count: 2, categories: ['tech', 'life'] },
      { v: 1, ts: '2026-07-10T15:00:00.000Z', mode: 'store', event: 'store.apply', ok: true, count: 1, categories: ['tech'] },
      { v: 1, ts: '2026-07-12T09:00:00.000Z', mode: 'show', event: 'show.open', ok: true },
      { v: 1, ts: '2026-08-01T09:00:00.000Z', mode: 'organize', event: 'organize.apply', ok: true, count: 3, proposalKinds: ['merge-file', 'split-category', 'delete-file'] },
      { v: 1, ts: '2026-08-02T09:00:00.000Z', mode: 'store', event: 'store.apply', ok: false, err: { code: 'PII_BLOCKED', message: 'blocked' } },
    ];

    const s = await aggregateUsage(records);

    expect(s.range).toEqual({ from: '2026-07-10T09:00:00.000Z', to: '2026-08-02T09:00:00.000Z' });
    expect(s.totals).toEqual({ store: 3, organize: 1, show: 1, notesCreated: 3, notesDeleted: 2 });
    expect(s.storeCountByDay).toEqual([{ date: '2026-07-10', count: 3 }]);
    expect(s.notesByCategory).toEqual([
      { category: 'tech', count: 2 },
      { category: 'life', count: 1 },
    ]);
    expect(s.modeCountByMonth).toEqual([
      { month: '2026-07', store: 2, organize: 0, show: 1 },
      { month: '2026-08', store: 1, organize: 1, show: 0 },
    ]);
    expect(s.lastUsedAt).toEqual({
      store: '2026-08-02T09:00:00.000Z',
      organize: '2026-08-01T09:00:00.000Z',
      show: '2026-07-12T09:00:00.000Z',
    });
    expect(s.skippedLogLines).toBe(0);
  });

  it('is order-independent (sorts by ts internally)', async () => {
    const records: UsageRecord[] = [
      { v: 1, ts: '2026-07-12T09:00:00.000Z', mode: 'store', event: 'store.apply', ok: true, count: 1 },
      { v: 1, ts: '2026-07-10T09:00:00.000Z', mode: 'store', event: 'store.apply', ok: true, count: 1 },
    ];
    const s = await aggregateUsage(records);
    expect(s.range).toEqual({ from: '2026-07-10T09:00:00.000Z', to: '2026-07-12T09:00:00.000Z' });
  });

  it('defaults a missing store count to 1 note', async () => {
    const s = await aggregateUsage([
      { v: 1, ts: '2026-07-10T09:00:00.000Z', mode: 'store', event: 'store.apply', ok: true },
    ]);
    expect(s.totals.notesCreated).toBe(1);
    expect(s.storeCountByDay).toEqual([{ date: '2026-07-10', count: 1 }]);
  });

  it('feeds cleanly from readUsage output', async () => {
    const root = await mkProject();
    await appendUsage(root, rec({ ts: '2026-07-10T09:00:00.000Z', event: 'store.apply', count: 2 }));
    await appendUsage(root, rec({ ts: '2026-07-11T09:00:00.000Z', mode: 'show', event: 'show.open' }));
    const { records } = await readUsage(root);
    const s = await aggregateUsage(records);
    expect(s.totals.store).toBe(1);
    expect(s.totals.show).toBe(1);
    expect(s.totals.notesCreated).toBe(2);
  });
});
