import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { resolveRuntimeEntrypoint, runtimeCommand } from 'draft-core/runtime';

export function resolveIntelligenceAdapter(
  backgroundDir: string,
  name: string,
  exists: (path: string) => boolean = existsSync,
): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('invalid intelligence adapter name');
  const entrypoint = resolveRuntimeEntrypoint(join(backgroundDir, 'intelligence', name), { exists });
  if (!entrypoint) throw new Error(`intelligence adapter not found: ${name}`);
  return entrypoint.path;
}

export interface ContextSnapshotFile {
  relativePath: string;
  snapshotPath: string;
  sha256: string;
}

export interface ContextSnapshot {
  snapshotPath: string;
  files: ContextSnapshotFile[];
  tensions: ContextSnapshotFile | null;
}

interface ContextSnapshotOptions {
  makeTempDir?: () => string;
  writeSnapshotFile?: (path: string, content: Buffer) => void;
}

/**
 * Copy the workspace's regular context/<dimension>/index.md files into a
 * host-owned, read-only snapshot. Symlinks fail closed instead of being
 * followed. Call cleanupContextSnapshot when the consumer is finished.
 */
export function createContextSnapshot(
  workspace: string,
  options: ContextSnapshotOptions = {},
): ContextSnapshot {
  const makeTempDir = options.makeTempDir
    ?? (() => mkdtempSync(join(tmpdir(), 'draft-context-snapshot-')));
  const writeSnapshotFile = options.writeSnapshotFile
    ?? ((path: string, content: Buffer) => writeFileSync(path, content));
  const snapshotPath = makeTempDir();

  try {
    const sources = listContextIndexFiles(workspace);
    const copy = (source: { relativePath: string; sourcePath: string }): ContextSnapshotFile => {
      const content = readFileSync(source.sourcePath);
      const target = join(snapshotPath, source.relativePath);
      mkdirSync(dirname(target), { recursive: true });
      writeSnapshotFile(target, content);
      chmodSync(target, 0o444);
      return {
        relativePath: source.relativePath,
        snapshotPath: target,
        sha256: createHash('sha256').update(content).digest('hex'),
      };
    };

    return {
      snapshotPath,
      files: sources.files.map(copy),
      tensions: sources.tensions ? copy(sources.tensions) : null,
    };
  } catch (error) {
    rmSync(snapshotPath, { recursive: true, force: true });
    throw error;
  }
}

export function cleanupContextSnapshot(
  snapshot: ContextSnapshot | string,
): void {
  const snapshotPath = typeof snapshot === 'string' ? snapshot : snapshot.snapshotPath;
  rmSync(snapshotPath, { recursive: true, force: true });
}

function listContextIndexFiles(
  workspace: string,
): {
  files: Array<{ relativePath: string; sourcePath: string }>;
  tensions: { relativePath: string; sourcePath: string } | null;
} {
  // TODO(cloud-context): this daemon snapshot still reads the local projection.
  // Replace it with the workspace context API when local context is retired.
  const contextDir = join(workspace, 'context');
  if (!existsSync(contextDir)) return { files: [], tensions: null };

  const contextStat = lstatSync(contextDir);
  if (contextStat.isSymbolicLink()) {
    throw new Error('context snapshot rejected symlink: context');
  }
  if (!contextStat.isDirectory()) {
    throw new Error('context snapshot requires context to be a directory');
  }

  const sources: Array<{ relativePath: string; sourcePath: string }> = [];
  let tensions: { relativePath: string; sourcePath: string } | null = null;
  for (const entry of readdirSync(contextDir, { withFileTypes: true })) {
    const relativeDimensionPath = join('context', entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`context snapshot rejected symlink: ${relativeDimensionPath}`);
    }
    if (entry.name === 'tensions.md' && entry.isFile()) {
      tensions = {
        relativePath: relativeDimensionPath,
        sourcePath: join(contextDir, entry.name),
      };
      continue;
    }
    if (!entry.isDirectory()) continue;

    const sourcePath = join(contextDir, entry.name, 'index.md');
    if (!existsSync(sourcePath)) continue;
    const stat = lstatSync(sourcePath);
    const relativePath = join(relativeDimensionPath, 'index.md');
    if (stat.isSymbolicLink()) {
      throw new Error(`context snapshot rejected symlink: ${relativePath}`);
    }
    if (!stat.isFile()) continue;
    sources.push({ relativePath, sourcePath });
  }

  return {
    files: sources.sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
    tensions,
  };
}

export interface IntelligenceInvocation {
  adapterPath: string;
  prompt: string;
  outputPath: string;
}

export interface IntelligenceDeps {
  invoke(input: IntelligenceInvocation): Promise<number>;
  makeTemp(prefix: string): string;
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  removeFile(path: string): void;
  exists(path: string): boolean;
}

export const systemIntelligenceDeps: IntelligenceDeps = {
  async invoke({ adapterPath, prompt, outputPath }) {
    const promptPath = this.makeTemp('draft-prompt');
    this.writeFile(promptPath, prompt);
    try {
      const kind = adapterPath.endsWith('.sh') ? 'sh' : adapterPath.endsWith('.js') ? 'js' : 'ts';
      const command = runtimeCommand({ path: adapterPath, kind }, [promptPath, outputPath]);
      if (!command) throw new Error('bun runtime not found for intelligence adapter');
      const child = Bun.spawn(command, {
        stdin: 'ignore', stdout: 'ignore', stderr: 'inherit',
      });
      return await child.exited;
    } finally {
      this.removeFile(promptPath);
    }
  },
  makeTemp(prefix) {
    const path = join('/tmp', `${prefix}-${process.pid}-${crypto.randomUUID()}`);
    writeFileSync(path, '');
    return path;
  },
  readFile: path => readFileSync(path, 'utf8'),
  writeFile: (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); },
  removeFile: path => rmSync(path, { force: true }),
  exists: existsSync,
};

export async function runIntelligence(
  input: IntelligenceInvocation,
  deps: IntelligenceDeps,
): Promise<string> {
  if (!deps.exists(input.adapterPath)) throw new Error(`intelligence adapter not found: ${input.adapterPath}`);
  const exit = await deps.invoke(input);
  if (exit !== 0) throw new Error(`intelligence adapter exited ${exit}`);
  if (!deps.exists(input.outputPath)) throw new Error('intelligence adapter returned empty output');
  const output = deps.readFile(input.outputPath);
  if (!output.length) throw new Error('intelligence adapter returned empty output');
  return output;
}
