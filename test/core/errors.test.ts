import { describe, expect, it } from 'vitest';
import { ERROR_CODES, isMnemoError, MnemoError } from '../../src/core/errors.js';
import type { ErrorCode } from '../../src/core/errors.js';
import * as core from '../../src/core/index.js';

describe('MnemoError', () => {
  it('exposes code / message / details', () => {
    const err = new MnemoError('LOCK_TIMEOUT', 'ロック取得に失敗', { x: 1 });
    expect(err.code).toBe('LOCK_TIMEOUT');
    expect(err.message).toBe('ロック取得に失敗');
    expect(err.details).toEqual({ x: 1 });
  });

  it('falls back to the code string when message is undefined', () => {
    const err = new MnemoError('LOCK_TIMEOUT', undefined, { x: 1 });
    expect(err.message).toBe('LOCK_TIMEOUT');
    expect(err.details).toEqual({ x: 1 });
  });

  it('allows details to be omitted', () => {
    const err = new MnemoError('NOT_INITIALIZED');
    expect(err.message).toBe('NOT_INITIALIZED');
    expect(err.details).toBeUndefined();
  });

  it('is an Error / MnemoError instance with name "MnemoError"', () => {
    const err = new MnemoError('CONFIG_CORRUPT');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(MnemoError);
    expect(err.name).toBe('MnemoError');
    expect(isMnemoError(err)).toBe(true);
    expect(isMnemoError(new Error('x'))).toBe(false);
  });

  it('can be caught by code after being thrown', () => {
    try {
      throw new MnemoError('VAULT_UNAVAILABLE', undefined, { projectRoot: '/tmp/x' });
    } catch (e) {
      expect(isMnemoError(e)).toBe(true);
      if (isMnemoError(e)) {
        expect(e.code).toBe('VAULT_UNAVAILABLE');
        expect(e.details).toEqual({ projectRoot: '/tmp/x' });
      }
    }
  });
});

describe('ErrorCode union', () => {
  const expected: readonly ErrorCode[] = [
    'NOT_INITIALIZED',
    'CONFIG_CORRUPT',
    'PROJECT_NOT_WRITABLE',
    'VAULT_UNAVAILABLE',
    'VAULT_NOT_WRITABLE',
    'NODE_MODULES_MISSING',
    'RUNTIME_DIR_UNWRITABLE',
    'LOCK_TIMEOUT',
    'FRONTMATTER_PARSE',
    'FRONTMATTER_SCHEMA',
    'CATEGORY_INVARIANT',
    'SLUG_COLLISION',
    'SLUG_INVALID',
    'PII_BLOCKED',
    'ORGANIZE_SESSION_EXPIRED',
    'DESTRUCTIVE_NOT_CONFIRMED',
    'PROPOSAL_CONFLICT',
    'SNAPSHOT_FAILED',
    'PORT_UNAVAILABLE',
    'SERVER_START_TIMEOUT',
    'BROWSER_OPEN_FAILED',
    'INDEX_BUILD_FAILED',
    'QUERY_TOO_SHORT',
    'NODE_VERSION_UNSUPPORTED',
    'SNIPPET_STALE',
    'UNAUTHORIZED',
  ];

  it('has exactly 26 codes', () => {
    expect(ERROR_CODES).toHaveLength(26);
    expect(new Set(ERROR_CODES).size).toBe(26);
  });

  it('contains every expected code and nothing else', () => {
    expect([...ERROR_CODES].sort()).toEqual([...expected].sort());
  });

  it('every code is usable as MnemoError.code', () => {
    for (const code of ERROR_CODES) {
      expect(new MnemoError(code).code).toBe(code);
    }
  });

  it('does NOT include NODE_MODULES_STALE (doctor warn label only, §9-5-1)', () => {
    expect(ERROR_CODES as readonly string[]).not.toContain('NODE_MODULES_STALE');
  });
});

describe('core barrel re-export', () => {
  it('re-exports MnemoError / ERROR_CODES / isMnemoError from src/core/index.ts', () => {
    expect(core.MnemoError).toBe(MnemoError);
    expect(core.ERROR_CODES).toBe(ERROR_CODES);
    expect(core.isMnemoError).toBe(isMnemoError);
  });
});
