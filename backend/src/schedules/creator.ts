/** Who a routine is made for (a person) and what made it. */
export interface RoutineCreator {
  /** Always a human: the caller, or the person a run acts for. */
  userId: string;
  via: "app" | "cli" | "mcp" | "run" | "system";
  /** Set only when via is "run". */
  runId: string | null;
  /** 0 for people; a run's parent routine depth + 1. */
  depth: number;
  visibility: "private" | "shared";
}

export function personCreator(userId: string, via: "app" | "cli" | "mcp"): RoutineCreator {
  return { userId, via, runId: null, depth: 0, visibility: "shared" };
}
