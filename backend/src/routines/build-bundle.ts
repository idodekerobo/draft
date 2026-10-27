import { computeBundleHash } from "../sandbox/bundle-hash";
import type { SandboxRunBundle } from "../sandbox";
import { routineRunId } from "./config";

const SAFE_DOCUMENT_PATH = /^[A-Za-z0-9._\-/]+\.md$/;

const PREAMBLE = [
  "You are running as a scheduled routine for a company. Its shared knowledge is in Markdown files under /run/input/context.",
  "Use the Glob and Read tools to read them. You have no other tools and no internet access.",
  "Answer the request below. Your reply is saved as the result of this run.",
].join("\n");

export function renderRoutinePrompt(prompt: string): string {
  return `${PREAMBLE}\n\n---\n\n${prompt.trim()}\n`;
}

/** The brain's documents as files under input/context, like a synthesis run's bundle. Unsafe paths are left out. */
export function buildRoutineBundle(input: {
  organizationId: string;
  workspaceId: string;
  sessionId: string;
  documents: Record<string, { content: string }>;
}): SandboxRunBundle {
  const files: Record<string, { content: string }> = {};
  for (const [path, document] of Object.entries(input.documents)) {
    if (!SAFE_DOCUMENT_PATH.test(path) || path.startsWith("/") || path.split("/").includes("..")) continue;
    files[`input/context/${path}`] = { content: document.content };
  }
  if (Object.keys(files).length === 0) files["input/context/README.md"] = { content: "The company brain has no documents yet.\n" };

  return {
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    runId: routineRunId(input.sessionId),
    bundleHash: computeBundleHash(Object.fromEntries(Object.entries(files).map(([path, file]) => [path, file.content]))),
    files,
  };
}
