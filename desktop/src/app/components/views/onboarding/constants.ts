// constants.ts — tool options and prerequisites for onboarding install step

import type { InstallableTool } from "../../../../rpc/schema";

export interface ToolOption {
  id: InstallableTool;
  name: string;
  description: string;
}

export const TOOL_PREREQS: Partial<Record<InstallableTool, { label: string; url: string }>> = {
  "claude-code": {
    label: "Claude Code CLI",
    url: "https://code.claude.com/docs/en/quickstart",
  },
  codex: {
    label: "Codex CLI",
    url: "https://developers.openai.com/codex/cli",
  },
  cursor: {
    label: "Cursor",
    url: "https://cursor.com/get-started",
  },
  openclaw: {
    label: "OpenClaw CLI",
    url: "https://docs.openclaw.ai/",
  },
  hermes: {
    label: "Hermes CLI",
    url: "https://hermes-agent.nousresearch.com/docs/getting-started/quickstart",
  },
};

export const TOOL_OPTIONS: ToolOption[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    description: "Context injected at session start · post-session synthesis",
  },
  {
    id: "codex",
    name: "Codex",
    description: "Context injected at session start · post-session synthesis",
  },
  {
    id: "cursor",
    name: "Cursor",
    description: "Context applied via Cursor rules at session start",
  },
  {
    id: "openclaw",
    name: "OpenClaw",
    description: "Context injected at session start · post-session synthesis",
  },
  {
    id: "hermes",
    name: "Hermes",
    description: "Context injected at session start · post-session synthesis",
  },
];
