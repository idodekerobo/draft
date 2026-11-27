/** The AI labs a workspace can pick for Draft's own agent. Only enabled ones can be chosen today. */
export const MODEL_PROVIDERS = [
  { id: "anthropic", label: "Anthropic", enabled: true },
  { id: "openai", label: "OpenAI", enabled: false },
] as const;

export type ModelProviderId = (typeof MODEL_PROVIDERS)[number]["id"];

export const DEFAULT_MODEL_PROVIDER: ModelProviderId = "anthropic";

/** The session harness that runs on a lab's models: what a new session starts with until the person picks another. */
export const harnessForModelProvider = (provider: string | null | undefined): "claude" | "codex" => (provider === "openai" ? "codex" : "claude");

/** True for a lab that exists and can be chosen now. */
export const isChoosableModelProvider = (value: unknown): value is ModelProviderId =>
  MODEL_PROVIDERS.some((provider) => provider.id === value && provider.enabled);
