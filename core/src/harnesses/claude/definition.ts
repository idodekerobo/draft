import type { HarnessDefinition, ReasoningEffort } from "../types";
import { claudeAdapters } from "./adapters";

/** Claude Code's `--effort` levels. Its own setting decides the default. */
const CLAUDE_EFFORTS: ReadonlyArray<ReasoningEffort> = ["low", "medium", "high", "xhigh", "max"];

export const claudeDefinition = {
  id: "claude",
  label: "Claude Code",
  models: [
    { alias: null, label: "Default", efforts: CLAUDE_EFFORTS, defaultEffort: null },
    { alias: "fable", label: "Fable", efforts: CLAUDE_EFFORTS, defaultEffort: null },
    { alias: "opus", label: "Opus", efforts: CLAUDE_EFFORTS, defaultEffort: null },
    { alias: "sonnet", label: "Sonnet", efforts: CLAUDE_EFFORTS, defaultEffort: null },
    { alias: "haiku", label: "Haiku", efforts: CLAUDE_EFFORTS, defaultEffort: null },
  ],
  adapters: claudeAdapters,
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
