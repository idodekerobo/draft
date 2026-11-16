import { DEFAULT_HARNESS_ID, HARNESSES, type HarnessId } from "draft-core/harnesses";
import type { RoutineAgentStatus } from "./types";

const KEY = "draft.routines.lastAgent";

type AgentChoice = { harness: HarnessId; model: string | null; effort: string | null };

/** The agent the person used last, if it can still run routines; else the first connected one. */
export function defaultAgent(agents: Partial<Record<string, RoutineAgentStatus>>, storage: Pick<Storage, "getItem"> | null = safeStorage()): AgentChoice {
  const usable = (harness: string) => agents[harness] === undefined || agents[harness] === "connected";
  try {
    const saved = JSON.parse(storage?.getItem(KEY) ?? "null") as Partial<AgentChoice> | null;
    if (saved?.harness && HARNESSES.some((entry) => entry.id === saved.harness) && usable(saved.harness)) {
      return { harness: saved.harness, model: typeof saved.model === "string" ? saved.model : null, effort: typeof saved.effort === "string" ? saved.effort : null };
    }
  } catch {
    // A bad or blocked value falls through to the connected agent.
  }
  const connected = HARNESSES.find((entry) => entry.routineModes.length > 0 && agents[entry.id] === "connected");
  return { harness: connected?.id ?? DEFAULT_HARNESS_ID, model: null, effort: null };
}

export function rememberAgent(choice: AgentChoice, storage: Pick<Storage, "setItem"> | null = safeStorage()): void {
  try {
    storage?.setItem(KEY, JSON.stringify(choice));
  } catch {
    // Remembering is a convenience; a blocked store is fine.
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
