import { computeBundleHash } from "../sandbox/bundle-hash";
import { assertSafeDocumentPath } from "../synthesis/context-version-files";
import type { SandboxRunBundle } from "../sandbox";
import { visibleContext, type ContextAudience } from "../metaharness/context/visible-context";

export interface RoutinePromptContext {
  title: string;
  /** The cadence in words, for example "Daily at 9:00 AM". */
  schedule: string;
  timezone: string;
  startedAt: Date;
  /** True when the run has Draft's tool server, so the prompt can say so. */
  hasDraftTools?: boolean;
}

function startedAtIn(timezone: string, startedAt: Date): string {
  const format = (timeZone: string) => new Intl.DateTimeFormat("en-US", { dateStyle: "full", timeStyle: "short", timeZone }).format(startedAt);
  try {
    return format(timezone);
  } catch {
    return `${format("UTC")} UTC`;
  }
}

/** One text for every agent: it names no tool, because each agent reads files with its own. */
export function renderRoutinePrompt(prompt: string, context: RoutinePromptContext): string {
  const preamble = [
    "You are running as a scheduled routine.",
    `Routine: ${context.title}`,
    `Schedule: ${context.schedule} (${context.timezone})`,
    `This run started: ${startedAtIn(context.timezone, context.startedAt)}`,
    "",
    "The company's shared knowledge is in Markdown files under /run/input/context. Read them as needed. They are read-only.",
    ...(context.hasDraftTools
      ? [
          "Draft's own tools are in the \"draft\" tool server. Use them for what they list, such as reading the company context.",
          "To change the company context, call its context.write tool with the COMPLETE new content of each changed Markdown file. Write only when the request below asks for it. " +
            "Leave baseSha out for a file you read from /run/input/context, and send baseSha null for a new file. " +
            "If the reply lists conflicts, someone changed that file since you read it: merge your change into its currentContent and write again with baseSha set to its currentSha, or drop the change. Stop when retryable is false.",
        ]
      : []),
    "Answer the request below. Your reply is saved as the result of this run.",
  ].join("\n");
  return `${preamble}\n\n---\n\n${prompt.trim()}\n`;
}

/** The brain's documents as files under input/context, like a synthesis run's bundle. Unsafe paths are left out. */
export function buildRoutineBundle(input: {
  organizationId: string;
  workspaceId: string;
  /** The agent run's id. The sandbox reports under it. */
  agentRunId: string;
  audience: ContextAudience;
  documents: Record<string, { content: string }>;
}): SandboxRunBundle {
  const files: Record<string, { content: string }> = {};
  for (const [path, document] of Object.entries(visibleContext(input.audience, input.documents))) {
    try {
      assertSafeDocumentPath(path);
    } catch {
      continue;
    }
    files[`input/context/${path}`] = { content: document.content };
  }
  if (Object.keys(files).length === 0) files["input/context/README.md"] = { content: "The company brain has no documents yet.\n" };

  return {
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    runId: input.agentRunId,
    bundleHash: computeBundleHash(Object.fromEntries(Object.entries(files).map(([path, file]) => [path, file.content]))),
    files,
  };
}
