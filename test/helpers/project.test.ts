import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeProject, simulateCloneState } from './project.js';
import { withRuntimeDir } from './runtime.js';

const created: string[] = [];

async function track(): Promise<string> {
  const root = await makeProject();
  created.push(root);
  return root;
}

afterEach(() => {
  while (created.length > 0) {
    const root = created.pop();
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

describe('makeProject()', () => {
  it('returns an isolated projectRoot with the §13 layout', async () => {
    const root = await track();

    expect(fs.statSync(root).isDirectory()).toBe(true);
    expect(path.isAbsolute(root)).toBe(true);
    for (const rel of [
      '.mnemotheca',
      '.mnemotheca/index',
      'vault',
      'vault/knowledge',
      'vault/categories',
    ]) {
      expect(fs.statSync(path.join(root, rel)).isDirectory()).toBe(true);
    }
  });

  it('writes config.json with { v, createdAt, updatedAt }', async () => {
    const root = await track();
    const config = JSON.parse(
      fs.readFileSync(path.join(root, '.mnemotheca', 'config.json'), 'utf8'),
    ) as Record<string, unknown>;

    expect(config['v']).toBe(1);
    expect(typeof config['createdAt']).toBe('string');
    expect(typeof config['updatedAt']).toBe('string');
    expect(new Date(config['createdAt'] as string).toString()).not.toBe('Invalid Date');
  });

  it('writes vault/.mnemotheca-vault.json with { v, createdAt }', async () => {
    const root = await track();
    const marker = JSON.parse(
      fs.readFileSync(path.join(root, 'vault', '.mnemotheca-vault.json'), 'utf8'),
    ) as Record<string, unknown>;

    expect(marker['v']).toBe(1);
    expect(typeof marker['createdAt']).toBe('string');
    expect(marker['updatedAt']).toBeUndefined();
  });

  it('returns a unique root on every call', async () => {
    const a = await track();
    const b = await track();
    expect(a).not.toBe(b);
  });

  it('can be fully removed (afterEach-style cleanup)', async () => {
    const root = await makeProject();
    expect(fs.existsSync(root)).toBe(true);

    fs.rmSync(root, { recursive: true, force: true });
    expect(fs.existsSync(root)).toBe(false);
  });
});

describe('simulateCloneState()', () => {
  it('removes node_modules and .mnemotheca/{index,snapshots}, keeps config + vault', async () => {
    const root = await track();
    fs.mkdirSync(path.join(root, 'node_modules', 'mnemo'), { recursive: true });
    fs.mkdirSync(path.join(root, '.mnemotheca', 'snapshots', 'x-1'), { recursive: true });
    fs.writeFileSync(path.join(root, '.mnemotheca', 'index', 'search-index.json'), '{}');
    fs.writeFileSync(path.join(root, 'vault', 'knowledge', 'note.md'), '# note');

    simulateCloneState(root);

    expect(fs.existsSync(path.join(root, 'node_modules'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.mnemotheca', 'index'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.mnemotheca', 'snapshots'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.mnemotheca', 'config.json'))).toBe(true);
    expect(fs.readFileSync(path.join(root, 'vault', 'knowledge', 'note.md'), 'utf8')).toBe('# note');
  });

  it('is idempotent when the targets are already absent', async () => {
    const root = await track();
    expect(() => {
      simulateCloneState(root);
      simulateCloneState(root);
    }).not.toThrow();
  });
});

describe('withRuntimeDir()', () => {
  it('sets MNEMO_RUNTIME_DIR and restores it afterwards', () => {
    const before = process.env.MNEMO_RUNTIME_DIR;
    const handle = withRuntimeDir();

    expect(process.env.MNEMO_RUNTIME_DIR).toBe(handle.dir);
    expect(fs.statSync(handle.dir).isDirectory()).toBe(true);

    handle.restore();
    expect(process.env.MNEMO_RUNTIME_DIR).toBe(before);
    expect(fs.existsSync(handle.dir)).toBe(false);
  });

  it('keeps a caller-supplied dir but still restores the env var', () => {
    const before = process.env.MNEMO_RUNTIME_DIR;
    const supplied = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemo-rt-supplied-'));
    try {
      const handle = withRuntimeDir(supplied);
      expect(process.env.MNEMO_RUNTIME_DIR).toBe(supplied);
      handle.restore();
      expect(process.env.MNEMO_RUNTIME_DIR).toBe(before);
      expect(fs.existsSync(supplied)).toBe(true);
    } finally {
      fs.rmSync(supplied, { recursive: true, force: true });
    }
  });
});
