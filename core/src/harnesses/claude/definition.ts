import type { HarnessDefinition } from "../types";

export const claudeDefinition = {
  id: "claude",
  label: "Claude Code",
  models: [
    { alias: null, label: "Default" },
    { alias: "fable", label: "Fable" },
    { alias: "opus", label: "Opus" },
    { alias: "sonnet", label: "Sonnet" },
    { alias: "haiku", label: "Haiku" },
  ],
  capabilities: { terminal: true, approvals: true, steer: false },
  modes: {
    permission: [
      { value: "default", label: "Manual", description: "Asks before edits and commands" },
      { value: "auto", label: "Auto", description: "Runs on its own; a classifier blocks risky actions" },
      { value: "acceptEdits", label: "Accept edits", description: "Applies file edits; commands still ask" },
      { value: "plan", label: "Plan", description: "Plans only, and makes no edits" },
    ],
    approval: [],
  },
  testedVersion: { major: 2, minor: 1 },
  cloudStartingTools: ["Read", "Glob"],
  routineModes: ["print"],
} as const satisfies HarnessDefinition;
