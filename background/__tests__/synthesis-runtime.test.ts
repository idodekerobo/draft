import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  cleanupContextSnapshot,
  createContextSnapshot,
} from '../synthesizers/synthesis-runtime';

const temporaryPaths: string[] = [];

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(`/tmp/${prefix}-`);
  temporaryPaths.push(path);
  return path;
}

function writeContext(workspace: string, dimension: string, content: Buffer | string): void {
  const directory = join(workspace, 'context', dimension);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'index.md'), content);
}

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe('createContextSnapshot', () => {
  it('returns sorted context index snapshots with exact bytes and hashes', () => {
    const workspace = temporaryDirectory('draft-snapshot-workspace');
    const product = Buffer.from('# Product\r\nExact bytes.\n', 'utf8');
    const priorities = Buffer.from([0x23, 0x20, 0x50, 0x72, 0x69, 0x6f, 0x72, 0x69, 0x74, 0x69, 0x65, 0x73, 0x0a]);
    writeContext(workspace, 'product', product);
    writeContext(workspace, 'priorities', priorities);
    const tensions = Buffer.from('# Tensions\nExact conflict bytes.\r\n', 'utf8');
    writeFileSync(join(workspace, 'context', 'tensions.md'), tensions);
    mkdirSync(join(workspace, 'context', 'empty'), { recursive: true });

    const snapshot = createContextSnapshot(workspace);
    temporaryPaths.push(snapshot.snapshotPath);

    expect(snapshot.snapshotPath).toStartWith(join(tmpdir(), 'draft-context-snapshot-'));
    expect(snapshot.files.map(file => file.relativePath)).toEqual([
      'context/priorities/index.md',
      'context/product/index.md',
    ]);

    for (const expected of [
      { relativePath: 'context/priorities/index.md', content: priorities },
      { relativePath: 'context/product/index.md', content: product },
    ]) {
      const file = snapshot.files.find(candidate => candidate.relativePath === expected.relativePath)!;
      expect(readFileSync(file.snapshotPath)).toEqual(expected.content);
      expect(file.sha256).toBe(createHash('sha256').update(expected.content).digest('hex'));
      expect(file.snapshotPath).toBe(join(snapshot.snapshotPath, expected.relativePath));
    }
    expect(snapshot.tensions).not.toBeNull();
    expect(snapshot.tensions?.relativePath).toBe('context/tensions.md');
    expect(readFileSync(snapshot.tensions!.snapshotPath)).toEqual(tensions);
    expect(snapshot.tensions?.sha256).toBe(
      createHash('sha256').update(tensions).digest('hex'),
    );
  });

  it('returns null when context/tensions.md is missing', () => {
    const workspace = temporaryDirectory('draft-snapshot-no-tensions-workspace');
    writeContext(workspace, 'product', 'product');
    const snapshot = createContextSnapshot(workspace);
    temporaryPaths.push(snapshot.snapshotPath);

    expect(snapshot.tensions).toBeNull();
  });

  it('fails closed when a dimension or index file is a symlink', () => {
    const workspace = temporaryDirectory('draft-snapshot-symlink-workspace');
    const outside = temporaryDirectory('draft-snapshot-outside');
    writeContext(outside, 'source', 'outside');
    mkdirSync(join(workspace, 'context'), { recursive: true });
    symlinkSync(join(outside, 'context', 'source'), join(workspace, 'context', 'linked-dimension'));

    expect(() => createContextSnapshot(workspace)).toThrow(
      'context snapshot rejected symlink: context/linked-dimension',
    );

    rmSync(join(workspace, 'context', 'linked-dimension'));
    mkdirSync(join(workspace, 'context', 'product'), { recursive: true });
    symlinkSync(
      join(outside, 'context', 'source', 'index.md'),
      join(workspace, 'context', 'product', 'index.md'),
    );

    expect(() => createContextSnapshot(workspace)).toThrow(
      'context snapshot rejected symlink: context/product/index.md',
    );
  });

  it('fails closed when context/tensions.md is a symlink', () => {
    const workspace = temporaryDirectory('draft-snapshot-tensions-symlink-workspace');
    const outside = temporaryDirectory('draft-snapshot-tensions-outside');
    mkdirSync(join(workspace, 'context'), { recursive: true });
    const outsideTensions = join(outside, 'tensions.md');
    writeFileSync(outsideTensions, 'outside tensions');
    symlinkSync(outsideTensions, join(workspace, 'context', 'tensions.md'));

    expect(() => createContextSnapshot(workspace)).toThrow(
      'context snapshot rejected symlink: context/tensions.md',
    );
  });

  it('cleanup removes the complete snapshot and is idempotent', () => {
    const workspace = temporaryDirectory('draft-snapshot-cleanup-workspace');
    writeContext(workspace, 'company', 'company context');
    const snapshot = createContextSnapshot(workspace);

    expect(existsSync(snapshot.snapshotPath)).toBe(true);
    cleanupContextSnapshot(snapshot);
    expect(existsSync(snapshot.snapshotPath)).toBe(false);
    expect(() => cleanupContextSnapshot(snapshot)).not.toThrow();
  });

  it('removes a partial snapshot when copying fails', () => {
    const workspace = temporaryDirectory('draft-snapshot-failure-workspace');
    writeContext(workspace, 'company', 'company');
    writeContext(workspace, 'product', 'product');
    const partialPath = join(temporaryDirectory('draft-snapshot-failure-parent'), 'snapshot');
    let writes = 0;

    expect(() => createContextSnapshot(workspace, {
      makeTempDir: () => {
        mkdirSync(partialPath);
        return partialPath;
      },
      writeSnapshotFile: (path, content) => {
        writes += 1;
        if (writes === 2) throw new Error('injected copy failure');
        writeFileSync(path, content);
      },
    })).toThrow('injected copy failure');

    expect(existsSync(partialPath)).toBe(false);
  });
});
