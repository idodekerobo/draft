import { createIntegrationOutput } from "../../integrations/safe-output.ts";

interface FixtureInput {
  mode?: string;
  json?: boolean;
  error?: unknown;
  secret?: string;
}

let input: FixtureInput = {};
try {
  input = await new Response(Bun.stdin.stream()).json() as FixtureInput;
} catch {}

const output = createIntegrationOutput({ json: input.json === true });
if (typeof input.secret === "string") output.registerSecret(input.secret);

switch (input.mode) {
  case "success":
    process.exitCode = output.event({ status: "connected", provider: "linear" });
    break;
  case "public_shape":
    process.exitCode = output.event({
      status: "ok",
      connections: [{
        provider: "github",
        status: "connected",
        connected: true,
        display_name: input.secret ?? null,
        last_success_at: null,
        last_error_at: null,
      }],
    });
    break;
  case "browser_github":
    process.exitCode = output.event({
      status: "browser_required",
      provider: "github",
      url: "https://github.com/apps/draft/installations/new?state=safe-state",
      expires_in_seconds: 300,
    });
    break;
  case "browser_slack":
    process.exitCode = output.event({
      status: "browser_required",
      provider: "slack",
      url: "https://api.slack.com/apps?new_app=1&manifest_json=%7B%22display_information%22%3A%7B%7D%7D",
    });
    break;
  case "browser_unsafe":
    process.exitCode = output.event({
      status: "browser_required",
      provider: "github",
      url: `https://example.com/install?token=${input.secret ?? "raw-canary"}`,
    });
    break;
  case "browser_unsafe_github_query":
    process.exitCode = output.event({
      status: "browser_required",
      provider: "github",
      url: `https://github.com/apps/draft/installations/new?state=safe-state&next=${input.secret ?? "raw-canary"}`,
    });
    break;
  case "browser_unsafe_slack_manifest":
    process.exitCode = output.event({
      status: "browser_required",
      provider: "slack",
      url: `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify({ token: input.secret ?? "raw-canary" }))}`,
    });
    break;
  case "throw":
    try {
      throw new Error(`raw throw ${input.secret ?? "raw-canary"}`);
    } catch (error) {
      process.exitCode = output.error(error);
    }
    break;
  default:
    process.exitCode = output.error(input.error);
}
