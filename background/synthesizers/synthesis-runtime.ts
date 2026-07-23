import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
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

export interface ContextInventory {
  files: string[];
  dimensions: string[];
}

export function discoverContext(workspace: string): ContextInventory {
  const contextDir = join(workspace, 'context');
  const files: string[] = [];
  try {
    for (const entry of readdirSync(contextDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = join(contextDir, entry.name, 'index.md');
      if (existsSync(file)) files.push(file);
    }
  } catch {}
  files.sort();
  return { files, dimensions: files.map(file => file.split('/').at(-2)!).sort() };
}

export function contextFileList(inventory: ContextInventory, empty: string): string {
  return inventory.files.length ? inventory.files.map(file => `   - ${file}`).join('\n') : empty;
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
