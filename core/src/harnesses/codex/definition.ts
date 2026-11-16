import type { HarnessDefinition, ReasoningEffort } from "../types";

/** From Codex's `model/list` (`supportedReasoningEfforts`, codex-cli 0.169). The Luna models stop at max. */
const UP_TO_MAX: ReadonlyArray<ReasoningEffort> = ["low", "medium", "high", "xhigh", "max"];
const UP_TO_ULTRA: ReadonlyArray<ReasoningEffort> = [...UP_TO_MAX, "ultra"];

export const codexDefinition = {
  id: "codex",
  label: "Codex",
  models: [
    { alias: null, label: "Default", efforts: UP_TO_MAX, defaultEffort: null },
    { alias: "gpt-6.1-sol", label: "GPT-6.1-Sol", efforts: UP_TO_ULTRA, defaultEffort: "low" },
    { alias: "gpt-6-astra", label: "GPT-6-Astra", efforts: UP_TO_ULTRA, defaultEffort: "low" },
    { alias: "gpt-6.1-terra", label: "GPT-6.1 Terra", efforts: UP_TO_ULTRA, defaultEffort: "low" },
    { alias: "gpt-6-sol", label: "GPT-6-Sol", efforts: UP_TO_ULTRA, defaultEffort: "medium" },
    { alias: "gpt-6-luna", label: "GPT-6-Luna", efforts: UP_TO_MAX, defaultEffort: "medium" },
    { alias: "gpt-5.6-sol", label: "GPT-5.6-Sol", efforts: UP_TO_ULTRA, defaultEffort: "low" },
    { alias: "gpt-5.6-terra", label: "GPT-5.6-Terra", efforts: UP_TO_ULTRA, defaultEffort: "medium" },
    { alias: "gpt-5.6-luna", label: "GPT-5.6-Luna", efforts: UP_TO_MAX, defaultEffort: "medium" },
  ],
  capabilities: { terminal: true, approvals: true, steer: true },
  modes: {
    permission: [
      { value: "default", label: "Default", description: "Works on the task and asks when it needs to" },
      { value: "plan", label: "Plan", description: "Plans first, and asks questions before it acts" },
    ],
    approval: [
      { value: "ask-for-approval", label: "Ask for approval", description: "Works in the folder; asks for outside edits and the internet" },
      { value: "approve-for-me", label: "Approve for me", description: "Only asks for actions a reviewer finds unsafe" },
      { value: "full-access", label: "Full access", description: "Runs everything with no prompts or sandbox" },
    ],
  },
  testedVersion: { major: 0, minor: 169 },
  cloudStartingTools: ["shell"],
  routineModes: ["exec"],
  installUrl: "https://learn.chatgpt.com/docs/codex/cli#getting-started",
} as const satisfies HarnessDefinition;
