import { randomUUID } from "node:crypto";
import { buildSummarizationPrompt } from "./render-prompt";
import { computeBundleHash } from "../metaharness/sandbox/bundle-hash";
import type { SandboxRunBundle } from "../metaharness/sandbox";
import type { CapturedSessionRow } from "../types/tables";

export const MANIFEST_PATH = "input/manifest.json";

export interface SummarizationSessionInput {
  session: Pick<CapturedSessionRow, "id">;
  transcript: string;
}

export interface SummarizationBundle extends SandboxRunBundle {
  manifestPath: string;
}

function promptPathFor(sessionId: string): string {
  return `input/sessions/${sessionId}/prompt.md`;
}

export function buildSummarizationBundle(input: {
  organizationId: string;
  workspaceId: string;
  sessions: SummarizationSessionInput[];
  runId?: string;
  instructions?: string;
}): SummarizationBundle {
  if (input.sessions.length === 0) {
    throw new Error("buildSummarizationBundle requires at least one session");
  }

  const runId = input.runId ?? `summarize:${input.workspaceId}:${randomUUID()}`;
  const files: Record<string, { content: string }> = {};

  const manifest = input.sessions.map(({ session }) => ({
    id: session.id,
    promptPath: promptPathFor(session.id),
  }));

  for (const { session, transcript } of input.sessions) {
    files[promptPathFor(session.id)] = { content: buildSummarizationPrompt(transcript, input.instructions) };
  }
  files[MANIFEST_PATH] = { content: `${JSON.stringify(manifest, null, 2)}\n` };

  const bundleHash = computeBundleHash(
    Object.fromEntries(Object.entries(files).map(([path, file]) => [path, file.content])),
  );

  return {
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    runId,
    bundleHash,
    files,
    manifestPath: MANIFEST_PATH,
  };
}
