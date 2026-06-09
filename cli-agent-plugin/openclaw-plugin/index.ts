import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { execSync, spawn } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";

const HOME = process.env.HOME!;
const SHARED_HOOKS = join(HOME, ".draft", "shared", "hooks");

function readActiveProfile(): string {
  try {
    return readFileSync(join(HOME, ".draft", "active-profile"), "utf8").trim() || "default";
  } catch {
    return "default";
  }
}

export default definePluginEntry({
  id: "draft",
  name: "Draft",
  description: "Draft context layer — injects workspace context and stages synthesis proposals",
  register: (api) => {
    // Inject DRAFT_WORKSPACE and feeds into every tool execution environment.
    // Reads active-profile at runtime so profile switches take effect without reinstalling.
    api.on("resolve_exec_env", async () => {
      const profile = readActiveProfile();
      return {
        DRAFT_WORKSPACE: join(HOME, ".draft", "workspaces", profile),
        DRAFT_PROFILE: profile,
        DRAFT_SHARED: join(HOME, ".draft", "shared"),
      };
    });

    // Session start: inject fresh workspace context into the first model turn.
    // Also ensures the Draft daemon is running (idempotent).
    api.on("session_start", async (event, ctx) => {
      const sessionKey = ctx.sessionKey ?? event.sessionKey ?? event.sessionId;
      try {
        const context = execSync(`bash "${join(SHARED_HOOKS, "inject-context.sh")}"`, {
          encoding: "utf8",
        });
        if (sessionKey) {
          await api.session.workflow.enqueueNextTurnInjection({ sessionKey, text: context });
        }
      } catch {
        // inject-context.sh failing must not block the session
      }
      // Start daemon if not already running (draft start is idempotent)
      spawn("draft", ["start"], { detached: true, stdio: "ignore" }).unref();
    });

    // Session end: write a pending record → daemon synthesizes on next poll cycle.
    api.on("session_end", async (event) => {
      const script = join(SHARED_HOOKS, "openclaw-session-end.sh");
      spawn("bash", [script, event.sessionId, event.sessionFile ?? "", event.reason ?? "unknown"], {
        detached: true,
        stdio: "ignore",
      }).unref();
    });
  },
});
