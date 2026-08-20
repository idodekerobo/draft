import { createHash, randomUUID } from "node:crypto";
import { buildSummarizationPrompt } from "./render-prompt";
import type { SandboxRunBundle } from "../sandbox";
import type { AgentSessionRow } from "../types/tables";

export const MANIFEST_PATH = "input/manifest.json";

export interface SummarizationSessionInput {
  session: Pick<AgentSessionRow, "id">;
  transcript: string;
}

export interface SummarizationBundle extends SandboxRunBundle {
  manifestPath: string;
}

function promptPathFor(sessionId: string): string {
  return `input/sessions/${sessionId}/prompt.md`;
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function buildSummarizationBundle(input: {
  organizationId: string;
  workspaceId: string;
  sessions: SummarizationSessionInput[];
  runId?: string;
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
    files[promptPathFor(session.id)] = { content: buildSummarizationPrompt(transcript) };
  }
  files[MANIFEST_PATH] = { content: `${JSON.stringify(manifest, null, 2)}\n` };

  const bundleHash = sha256(
    JSON.stringify(
      Object.keys(files)
        .sort()
        .map((path) => [path, sha256(files[path].content)]),
    ),
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
