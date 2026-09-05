// test/server/watcher.test.ts — 設計 §6-5 / §13-13a / 付録 C V-8。
//
// chokidar は注入(deps.chokidar)でフェイク化し、イベントを手動 emit する。
// デバウンスは fake timers。実ファイル監視・実コマンド実行は一切行わない。

import { EventEmitter } from 'node:events';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FSWatcher } from 'chokidar';
import { createWatcher, makeIgnored, type ChokidarLike, type WatcherDeps } from '../../src/server/watcher.js';
import { vaultPaths } from '../../src/core/paths.js';
import type { IndexHandle } from '../../src/core/search.js';

const PROJECT_ROOT = path.resolve('/tmp/mnemo-watcher-test-proj');
const { knowledgeDir, root: VAULT_ROOT } = vaultPaths(PROJECT_ROOT);

// --- フェイク FSWatcher（EventEmitter ベース） ---
class FakeWatcher extends EventEmitter {
  closed = false;
  close = vi.fn(async (): Promise<void> => {
    this.closed = true;
  });
}

interface FakeChokidar {
  chokidar: ChokidarLike;
  watch: ReturnType<typeof vi.fn>;
  watchers: FakeWatcher[];
  calls: () => Array<{ paths: unknown; options: Record<string, unknown> }>;
}

function makeChokidar(opts: { throwOnCall?: number[] } = {}): FakeChokidar {
  const watchers: FakeWatcher[] = [];
  const recorded: Array<{ paths: unknown; options: Record<string, unknown> }> = [];
  const watch = vi.fn((paths: unknown, options: Record<string, unknown>) => {
    recorded.push({ paths, options });
    if (opts.throwOnCall?.includes(recorded.length)) {
      throw new Error('chokidar.watch init boom');
    }
    const w = new FakeWatcher();
    watchers.push(w);
    return w as unknown as FSWatcher;
  });
  return { chokidar: { watch } as unknown as ChokidarLike, watch, watchers, calls: () => recorded };
}

function baseDeps(over: Partial<WatcherDeps> = {}): WatcherDeps {
  return {
    handle: {} as IndexHandle,
    applyDelta: vi.fn(async () => undefined),
    isNetworkFs: () => false,
    logger: vi.fn(),
    ...over,
  };
}

const relInKnowledge = (rel: string): string => path.join(knowledgeDir, rel);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// ignored 関数（§13-13a: 各分岐）
// ---------------------------------------------------------------------------
describe('makeIgnored', () => {
  const ignored = makeIgnored();
  const fileStats = { isFile: () => true, isDirectory: () => false } as unknown as import('node:fs').Stats;
  const dirStats = { isFile: () => false, isDirectory: () => true } as unknown as import('node:fs').Stats;

  it('.md ファイル（stats あり）は通す', () => {
    expect(ignored(relInKnowledge('tech/foo.md'), fileStats)).toBe(false);
  });
  it('.MD 大文字拡張子も通す', () => {
    expect(ignored(relInKnowledge('tech/FOO.MD'), fileStats)).toBe(false);
  });
  it('.txt ファイルは弾く', () => {
    expect(ignored(relInKnowledge('tech/foo.txt'), fileStats)).toBe(true);
  });
  it('.png ファイルは弾く', () => {
    expect(ignored(relInKnowledge('tech/foo.png'), fileStats)).toBe(true);
  });
  it('. 始まりディレクトリ（.obsidian）は弾く → 配下は監視されない', () => {
    expect(ignored(relInKnowledge('.obsidian'), dirStats)).toBe(true);
    expect(ignored(path.join(knowledgeDir, '.obsidian'))).toBe(true);
  });
  it('. 始まりファイル（.DS_Store 等）は弾く', () => {
    expect(ignored(relInKnowledge('tech/.keep'), fileStats)).toBe(true);
  });
  it('knowledge 配下のサブディレクトリ（stats あり）は通す', () => {
    expect(ignored(relInKnowledge('tech/architecture'), dirStats)).toBe(false);
  });
  it('stats なし: 拡張子付きで .md でないものは弾く', () => {
    expect(ignored(relInKnowledge('tech/foo.txt'))).toBe(true);
    expect(ignored(relInKnowledge('tech/foo.png'))).toBe(true);
  });
  it('stats なし: .md パスは通す', () => {
    expect(ignored(relInKnowledge('tech/foo.md'))).toBe(false);
  });
  it('stats なし: 拡張子なし（ディレクトリ想定）は通す', () => {
    expect(ignored(relInKnowledge('tech/architecture'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// watch() 初期化引数（§13-13a: glob 非使用 / usePolling 分岐）
// ---------------------------------------------------------------------------
describe('createWatcher — watch() 初期化', () => {
  it('glob 文字列を watch() に渡さない（paths は knowledgeDir 絶対パス、ignored は関数）', async () => {
    const fake = makeChokidar();
    const w = createWatcher(PROJECT_ROOT, baseDeps({ chokidar: fake.chokidar }));

    expect(fake.watch).toHaveBeenCalledTimes(1);
    const { paths, options } = fake.calls()[0]!;
    expect(paths).toBe(knowledgeDir);
    expect(typeof paths).toBe('string');
    expect(paths as string).not.toContain('*');
    expect(paths as string).not.toContain('{');
    expect(typeof options.ignored).toBe('function');
    expect(options.ignoreInitial).toBe(true);
    expect(options.awaitWriteFinish).toEqual({ stabilityThreshold: 400, pollInterval: 100 });
    await w.close();
  });

  it('isNetworkFs=false → usePolling:false', async () => {
    const fake = makeChokidar();
    const w = createWatcher(PROJECT_ROOT, baseDeps({ chokidar: fake.chokidar, isNetworkFs: () => false }));
    const { options } = fake.calls()[0]!;
    expect(options.usePolling).toBe(false);
    expect(w.isPolling()).toBe(false);
    await w.close();
  });

  it('isNetworkFs=true → usePolling:true + interval:1000', async () => {
    const fake = makeChokidar();
    const isNetworkFs = vi.fn(() => true);
    const w = createWatcher(PROJECT_ROOT, baseDeps({ chokidar: fake.chokidar, isNetworkFs }));
    const { options } = fake.calls()[0]!;
    expect(options.usePolling).toBe(true);
    expect(options.interval).toBe(1000);
    expect(w.isPolling()).toBe(true);
    expect(isNetworkFs).toHaveBeenCalledWith(VAULT_ROOT);
    await w.close();
  });
});

// ---------------------------------------------------------------------------
// デバウンス（§13-13a: 500ms で 1 回だけバッチ / addDir・unlinkDir 無視）
// ---------------------------------------------------------------------------
describe('createWatcher — デバウンス', () => {
  it('500ms 以内の同一ファイル複数イベント → applyDelta 1 回 + index-updated 1 回', async () => {
    const fake = makeChokidar();
    const applyDelta = vi.fn(async () => undefined);
    const onUpdated = vi.fn();
    const w = createWatcher(PROJECT_ROOT, baseDeps({ chokidar: fake.chokidar, applyDelta }));
    w.onIndexUpdated(onUpdated);

    const wm = fake.watchers[0]!;
    wm.emit('add', relInKnowledge('tech/a.md'));
    wm.emit('change', relInKnowledge('tech/a.md'));
    wm.emit('change', relInKnowledge('tech/a.md'));

    await vi.advanceTimersByTimeAsync(499);
    expect(applyDelta).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(applyDelta).toHaveBeenCalledTimes(1);
    expect(applyDelta).toHaveBeenCalledWith({ type: 'change', relPath: 'knowledge/tech/a.md' });
    expect(onUpdated).toHaveBeenCalledTimes(1);
    expect(onUpdated).toHaveBeenCalledWith({ type: 'index-updated', changed: 1 });
    await w.close();
  });

  it('デバウンスは後続イベントでリセットされる', async () => {
    const fake = makeChokidar();
    const applyDelta = vi.fn(async () => undefined);
    const w = createWatcher(PROJECT_ROOT, baseDeps({ chokidar: fake.chokidar, applyDelta }));
    const wm = fake.watchers[0]!;

    wm.emit('add', relInKnowledge('tech/a.md'));
    await vi.advanceTimersByTimeAsync(300);
    wm.emit('change', relInKnowledge('tech/a.md'));
    await vi.advanceTimersByTimeAsync(300); // 合計 600ms だが最後のイベントから 300ms
    expect(applyDelta).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200); // 最後のイベントから 500ms
    expect(applyDelta).toHaveBeenCalledTimes(1);
    await w.close();
  });

  it('複数ファイルは 1 バッチで relPath ごとに applyDelta、index-updated は 1 回', async () => {
    const fake = makeChokidar();
    const applyDelta = vi.fn<(ev: { type: string; relPath: string }) => Promise<void>>(async () => undefined);
    const onUpdated = vi.fn();
    const w = createWatcher(PROJECT_ROOT, baseDeps({ chokidar: fake.chokidar, applyDelta }));
    w.onIndexUpdated(onUpdated);
    const wm = fake.watchers[0]!;

    wm.emit('add', relInKnowledge('tech/a.md'));
    wm.emit('add', relInKnowledge('tech/b.md'));
    wm.emit('unlink', relInKnowledge('tech/c.md'));

    await vi.advanceTimersByTimeAsync(500);
    expect(applyDelta).toHaveBeenCalledTimes(3);
    expect(applyDelta.mock.calls.map((c) => c[0])).toEqual([
      { type: 'add', relPath: 'knowledge/tech/a.md' },
      { type: 'add', relPath: 'knowledge/tech/b.md' },
      { type: 'unlink', relPath: 'knowledge/tech/c.md' },
    ]);
    expect(onUpdated).toHaveBeenCalledTimes(1);
    expect(onUpdated.mock.calls[0]![0]).toEqual({ type: 'index-updated', changed: 3 });
    await w.close();
  });

  it('addDir / unlinkDir は無視（購読しない）', async () => {
    const fake = makeChokidar();
    const applyDelta = vi.fn(async () => undefined);
    const w = createWatcher(PROJECT_ROOT, baseDeps({ chokidar: fake.chokidar, applyDelta }));
    const wm = fake.watchers[0]!;

    wm.emit('addDir', relInKnowledge('tech/newcat'));
    wm.emit('unlinkDir', relInKnowledge('tech/oldcat'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(applyDelta).not.toHaveBeenCalled();
    await w.close();
  });

  it('.md 以外のパスは二重ガードで applyDelta に渡さない', async () => {
    const fake = makeChokidar();
    const applyDelta = vi.fn(async () => undefined);
    const w = createWatcher(PROJECT_ROOT, baseDeps({ chokidar: fake.chokidar, applyDelta }));
    const wm = fake.watchers[0]!;

    wm.emit('add', relInKnowledge('tech/note.txt'));
    await vi.advanceTimersByTimeAsync(500);
    expect(applyDelta).not.toHaveBeenCalled();
    await w.close();
  });

  it('applyDelta の失敗はログに残し、他の relPath とコールバックは継続', async () => {
    const fake = makeChokidar();
    const logger = vi.fn();
    const applyDelta = vi
      .fn<(ev: { type: string; relPath: string }) => Promise<void>>()
      .mockRejectedValueOnce(new Error('lock timeout'))
      .mockResolvedValue(undefined);
    const onUpdated = vi.fn();
    const w = createWatcher(PROJECT_ROOT, baseDeps({ chokidar: fake.chokidar, applyDelta, logger }));
    w.onIndexUpdated(onUpdated);
    const wm = fake.watchers[0]!;

    wm.emit('add', relInKnowledge('tech/a.md'));
    wm.emit('add', relInKnowledge('tech/b.md'));
    await vi.advanceTimersByTimeAsync(500);

    expect(applyDelta).toHaveBeenCalledTimes(2);
    expect(logger).toHaveBeenCalled();
    expect(onUpdated).toHaveBeenCalledWith({ type: 'index-updated', changed: 1 });
    await w.close();
  });
});

// ---------------------------------------------------------------------------
// error イベント縮退（§6-5 / §13-13a）
// ---------------------------------------------------------------------------
describe('createWatcher — error 縮退', () => {
  it('error → ログ + usePolling:true で 1 回再起動、isDown は false', async () => {
    const fake = makeChokidar();
    const logger = vi.fn();
    const w = createWatcher(
      PROJECT_ROOT,
      baseDeps({ chokidar: fake.chokidar, logger, isNetworkFs: () => false }),
    );
    const first = fake.watchers[0]!;

    first.emit('error', new Error('ENOSPC'));
    await vi.advanceTimersByTimeAsync(1);

    expect(logger).toHaveBeenCalled();
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(fake.watch).toHaveBeenCalledTimes(2);
    expect(fake.calls()[1]!.options.usePolling).toBe(true);
    expect(fake.calls()[1]!.options.interval).toBe(1000);
    expect(w.isDown()).toBe(false);
    expect(w.isPolling()).toBe(true);
    await w.close();
  });

  it('再起動後にもう一度 error → watcherDown、HTTP 本体は生存（例外なし）', async () => {
    const fake = makeChokidar();
    const logger = vi.fn();
    const w = createWatcher(PROJECT_ROOT, baseDeps({ chokidar: fake.chokidar, logger }));

    fake.watchers[0]!.emit('error', new Error('ENOSPC'));
    await vi.advanceTimersByTimeAsync(1);
    expect(w.isDown()).toBe(false);

    fake.watchers[1]!.emit('error', new Error('EMFILE'));
    await vi.advanceTimersByTimeAsync(1);
    expect(w.isDown()).toBe(true);

    expect(logger).toHaveBeenCalled();
    await expect(w.close()).resolves.toBeUndefined();
  });

  it('再起動時の chokidar.watch() が throw → watcherDown', async () => {
    const fake = makeChokidar({ throwOnCall: [2] });
    const logger = vi.fn();
    const w = createWatcher(PROJECT_ROOT, baseDeps({ chokidar: fake.chokidar, logger }));

    fake.watchers[0]!.emit('error', new Error('ENOSPC'));
    await vi.advanceTimersByTimeAsync(1);

    expect(fake.watch).toHaveBeenCalledTimes(2);
    expect(w.isDown()).toBe(true);
    await w.close();
  });

  it('縮退後は新規イベントを applyDelta に渡さない', async () => {
    const fake = makeChokidar({ throwOnCall: [2] });
    const applyDelta = vi.fn(async () => undefined);
    const w = createWatcher(PROJECT_ROOT, baseDeps({ chokidar: fake.chokidar, applyDelta }));

    fake.watchers[0]!.emit('error', new Error('ENOSPC'));
    await vi.advanceTimersByTimeAsync(1);
    expect(w.isDown()).toBe(true);

    fake.watchers[0]!.emit('add', relInKnowledge('tech/a.md'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(applyDelta).not.toHaveBeenCalled();
    await w.close();
  });
});

// ---------------------------------------------------------------------------
// 初期化 throw 縮退（§6-5: chokidar.watch() が初期化時に throw）
// ---------------------------------------------------------------------------
describe('createWatcher — 初期化 throw', () => {
  it('初回 chokidar.watch() が throw → createWatcher は例外を投げず isDown:true', () => {
    const fake = makeChokidar({ throwOnCall: [1] });
    const logger = vi.fn();
    let w!: ReturnType<typeof createWatcher>;
    expect(() => {
      w = createWatcher(PROJECT_ROOT, baseDeps({ chokidar: fake.chokidar, logger }));
    }).not.toThrow();
    expect(w.isDown()).toBe(true);
    expect(logger).toHaveBeenCalled();
  });

  it('初期化 throw 後もイベントキュー・close は安全（HTTP 本体生存）', async () => {
    const fake = makeChokidar({ throwOnCall: [1] });
    const applyDelta = vi.fn(async () => undefined);
    const w = createWatcher(PROJECT_ROOT, baseDeps({ chokidar: fake.chokidar, applyDelta }));
    await expect(w.close()).resolves.toBeUndefined();
    expect(applyDelta).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// onIndexUpdated 登録/解除
// ---------------------------------------------------------------------------
describe('createWatcher — onIndexUpdated', () => {
  it('unsubscribe すると以後呼ばれない', async () => {
    const fake = makeChokidar();
    const applyDelta = vi.fn(async () => undefined);
    const cb = vi.fn();
    const w = createWatcher(PROJECT_ROOT, baseDeps({ chokidar: fake.chokidar, applyDelta }));
    const off = w.onIndexUpdated(cb);
    const wm = fake.watchers[0]!;

    wm.emit('add', relInKnowledge('tech/a.md'));
    await vi.advanceTimersByTimeAsync(500);
    expect(cb).toHaveBeenCalledTimes(1);

    off();
    wm.emit('add', relInKnowledge('tech/b.md'));
    await vi.advanceTimersByTimeAsync(500);
    expect(cb).toHaveBeenCalledTimes(1);
    await w.close();
  });

  it('close 後は debounce タイマーが解除され applyDelta が走らない', async () => {
    const fake = makeChokidar();
    const applyDelta = vi.fn(async () => undefined);
    const w = createWatcher(PROJECT_ROOT, baseDeps({ chokidar: fake.chokidar, applyDelta }));
    const wm = fake.watchers[0]!;

    wm.emit('add', relInKnowledge('tech/a.md'));
    await w.close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(applyDelta).not.toHaveBeenCalled();
    expect(fake.watchers[0]!.close).toHaveBeenCalled();
  });
});
