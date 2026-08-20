// Shared between materialize-summary.ts (auto-creates this row on first
// summarized session) and the connections route (Decision 9's workspace
// toggle) -- both must resolve to the exact same source_connections row.
export const CLAUDE_SESSION_CONNECTION_KEY = "agent-sessions";
