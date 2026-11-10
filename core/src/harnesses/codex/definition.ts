import type { HarnessDefinition } from "../types";

export const codexDefinition = {
  id: "codex",
  label: "Codex",
  models: [
    { alias: null, label: "Default" },
    { alias: "gpt-6.1-sol", label: "GPT-6.1-Sol" },
    { alias: "gpt-6-astra", label: "GPT-6-Astra" },
    { alias: "gpt-6.1-terra", label: "GPT-6.1 Terra" },
    { alias: "gpt-6-sol", label: "GPT-6-Sol" },
    { alias: "gpt-6-luna", label: "GPT-6-Luna" },
    { alias: "gpt-5.6-sol", label: "GPT-5.6-Sol" },
    { alias: "gpt-5.6-terra", label: "GPT-5.6-Terra" },
    { alias: "gpt-5.6-luna", label: "GPT-5.6-Luna" },
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
  testedVersion: { major: 0, minor: 165 },
  routineModes: ["exec"],
  installUrl: "https://learn.chatgpt.com/docs/codex/cli#getting-started",
} as const satisfies HarnessDefinition;
