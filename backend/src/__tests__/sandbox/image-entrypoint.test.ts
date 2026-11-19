import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const IMAGE = join(import.meta.dir, "..", "..", "sandbox", "image");
const read = (name: string) => readFileSync(join(IMAGE, name), "utf8");

// The routine path as it shipped before the cloud-session host. It must stay byte-for-byte the same.
const ROUTINE_BLOCK = `: "\${DRAFT_CALLBACK_URL:?DRAFT_CALLBACK_URL is required}"

callback_host="$({ node -e '
  const url = new URL(process.env.DRAFT_CALLBACK_URL);
  if (url.protocol !== "https:" || (url.port && url.port !== "443")) {
    throw new Error("callback must use HTTPS on port 443");
  }
  if (url.username || url.password) throw new Error("callback URL must not contain credentials");
  process.stdout.write(url.hostname);
'; } 2>/dev/null)" || {
  echo "[entrypoint] fatal: invalid callback URL" >&2
  exit 1
}

# The harness comes from the run manifest. The runner refuses a run without one.
harness="$({ node -e '
  const harness = JSON.parse(process.env.DRAFT_RUN_MANIFEST).harness;
  process.stdout.write(harness === "codex" ? "codex" : "claude");
'; } 2>/dev/null)" || harness="claude"

network="$({ node -e '
  const value = JSON.parse(process.env.DRAFT_RUN_MANIFEST).network ?? "restricted";
  if (value !== "open" && value !== "restricted") throw new Error("invalid network mode");
  process.stdout.write(value);
'; } 2>/dev/null)" || {
  echo "[entrypoint] fatal: invalid network mode" >&2
  exit 1
}

# A run reaches only its own model provider, the callback and the bundle storage.
if [ "$harness" = "codex" ]; then
  model_hosts="chatgpt.com auth.openai.com api.openai.com"
  export DRAFT_EGRESS_REQUIRED_HOST="chatgpt.com"
else
  model_hosts="api.anthropic.com"
  export DRAFT_EGRESS_REQUIRED_HOST="api.anthropic.com"
fi
if [ "$network" = "restricted" ]; then
  export DRAFT_EGRESS_HOSTS="\${model_hosts} \${callback_host} \${DRAFT_EGRESS_HOSTS:-}"
  export DRAFT_CALLBACK_HOST="$callback_host"
  /usr/local/sbin/configure-egress.sh
fi

exec node /opt/draft/runner.mjs`;

const HOST_EXEC = "exec gosu agent env HOME=/data DISABLE_AUTOUPDATER=1 /usr/local/bin/bun /opt/draft/host.mjs";

describe("entrypoint.sh", () => {
  it("keeps the routine path byte-for-byte, so an unset DRAFT_MODE still runs the runner", () => {
    expect(read("entrypoint.sh")).toContain(ROUTINE_BLOCK);
  });

  it("checks DRAFT_MODE before the routine path, and refuses a mode it does not know", () => {
    const entrypoint = read("entrypoint.sh");
    const dispatch = entrypoint.indexOf('case "${DRAFT_MODE:-routine}" in');
    expect(dispatch).toBeGreaterThan(-1);
    expect(dispatch).toBeLessThan(entrypoint.indexOf(ROUTINE_BLOCK));
    expect(entrypoint).toContain("DRAFT_MODE must be host or routine");
  });

  it("runs the host as the agent user with HOME on /data, then execs the host bundle", () => {
    expect(read("entrypoint.sh")).toContain(HOST_EXEC);
  });

  it("does not clear the environment for the host, so DRAFT_MCP_TOKEN reaches the agent's pane", () => {
    expect(read("entrypoint.sh")).not.toMatch(/\benv -i\b/);
  });

  it("hands /data to the agent user and points the driver's tmux path at the system binary", () => {
    const entrypoint = read("entrypoint.sh");
    expect(entrypoint).toContain('chown "$agent_uid:$agent_gid" /data /data/.draft /data/.draft/bin');
    expect(entrypoint).toContain("ln -sfn /usr/bin/tmux /data/.draft/bin/tmux");
  });

  it("restricts egress to the model providers, the API and the seed host, and runs the open policy otherwise", () => {
    const entrypoint = read("entrypoint.sh");
    expect(entrypoint).toContain("api.anthropic.com chatgpt.com auth.openai.com api.openai.com ${api_host} ${seed_host}");
    expect(entrypoint).toContain("/usr/local/sbin/configure-egress.sh");
    expect(entrypoint).toContain("/usr/local/sbin/configure-open-egress.sh");
  });

  it("reads the seed host from a snapshot or a repo, and a routine run's seed has none", () => {
    const script = /seed_host="\$\(\{ node -e '([\s\S]*?)'; \} 2>\/dev\/null\)"/.exec(read("entrypoint.sh"))![1]!;
    const hostOf = (seed: unknown) => Bun.spawnSync(["node", "-e", script], { env: { ...process.env, DRAFT_SEED: JSON.stringify(seed) } });
    expect(hostOf({ kind: "routine_run" })).toMatchObject({ exitCode: 0 });
    expect(hostOf({ kind: "routine_run" }).stdout.toString()).toBe("");
    expect(hostOf({ kind: "snapshot", url: "https://files.example.test/a.tgz?sig=x" }).stdout.toString()).toBe("files.example.test");
    expect(hostOf({ kind: "repo", gitRemote: "https://github.com/acme/app.git", branch: "main" }).stdout.toString()).toBe("github.com");
    expect(hostOf({ kind: "zip" }).exitCode).not.toBe(0);
  }, 30_000);

  it("never swallows a failure with '|| true'", () => {
    expect(read("entrypoint.sh")).not.toMatch(/\|\|\s*true\b/);
  });

  it("keeps Node's error text out of the log, since it can echo DRAFT_SEED", () => {
    expect(read("entrypoint.sh")).toContain("Node errors are dropped");
  });
});

describe("configure-open-egress.sh", () => {
  it("accepts the resolvers before it drops the private and metadata ranges", () => {
    const script = read("configure-open-egress.sh");
    const resolverAccept = script.indexOf("--dport 53 -j ACCEPT");
    expect(resolverAccept).toBeGreaterThan(-1);
    expect(resolverAccept).toBeLessThan(script.indexOf("for range in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16"));
    expect(script).toContain("for range in fc00::/7 fe80::/10");
  });

  it("leaves the default policy open, so only the listed ranges are blocked", () => {
    const script = read("configure-open-egress.sh");
    expect(script).toContain("iptables -P OUTPUT ACCEPT");
    expect(script).toContain("ip6tables -P OUTPUT ACCEPT");
    expect(script).not.toContain("-P OUTPUT DROP");
  });
});

describe("the image shell scripts", () => {
  it.each(["entrypoint.sh", "configure-egress.sh", "configure-open-egress.sh"])("%s parses under sh -n", (name) => {
    const result = Bun.spawnSync(["sh", "-n", join(IMAGE, name)]);
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  });
});

describe("Dockerfile", () => {
  it("installs Bun at a pinned version and checks the zip against its SHA-256", () => {
    const dockerfile = read("Dockerfile");
    expect(dockerfile).toContain("ARG BUN_VERSION=1.3.13");
    expect(dockerfile).toContain("ARG BUN_SHA256=79c0771fa8b92c33aae41e15a0e0d307ea99d0e2f00317c71c6c53237a78e25a");
    expect(dockerfile).toContain("bun-v${BUN_VERSION}/bun-linux-x64.zip");
    expect(dockerfile).toContain("sha256sum -c -");
    expect(dockerfile).toContain('test "$(/usr/local/bin/bun --version)" = "${BUN_VERSION}"');
  });

  it("installs tmux and copies the host bundle and the open-egress script", () => {
    const dockerfile = read("Dockerfile");
    expect(dockerfile).toMatch(/^\s+tmux \\$/m);
    expect(dockerfile).toContain("COPY host.mjs /opt/draft/host.mjs");
    expect(dockerfile).toContain("COPY configure-open-egress.sh /usr/local/sbin/configure-open-egress.sh");
  });

  it("sets the GitHub credential helper at system level, so the host's clone and the pane's git both use it", () => {
    const dockerfile = read("Dockerfile");
    expect(dockerfile).toContain("git config --system credential.https://github.com.helper draft");
    expect(dockerfile).toContain("COPY draft-github-token /usr/local/bin/draft-github-token");
  });
});

describe("gh", () => {
  it("stops when Draft gives no token, so gh never runs without one", () => {
    expect(read("gh")).toContain('token="$(/usr/local/bin/draft-github-token)" || exit 1');
  });
});

describe("draft-github-token", () => {
  const RUN = "11111111-2222-4333-8444-555555555555";
  let dir: string;
  let stub: string;
  let record: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "draft-github-token-"));
    stub = join(dir, "stub-fetch.cjs");
    record = join(dir, "requests.jsonl");
    // Stands in for the backend: records each request and answers with a token that expires in an hour.
    writeFileSync(
      stub,
      `const { appendFileSync } = require("node:fs");
globalThis.fetch = async (url, init) => {
  appendFileSync(process.env.STUB_RECORD, JSON.stringify({ url: String(url), method: init.method, authorization: init.headers.Authorization }) + "\\n");
  if (process.env.STUB_REFUSE) return new Response(JSON.stringify({ status: "refused", code: process.env.STUB_REFUSE, message: "server message" }), { status: 403, headers: { "content-type": "application/json" } });
  return new Response(JSON.stringify({ output: { token: "ghs_STUBTOKEN", expiresAt: new Date(Date.now() + 3600000).toISOString() } }), { status: 200, headers: { "content-type": "application/json" } });
};
`,
    );
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Runs the helper with only the given variables, plus the stub. Returns what it printed and what it asked the backend. */
  function runHelper(env: Record<string, string>) {
    const result = Bun.spawnSync(["sh", join(IMAGE, "draft-github-token")], {
      env: { PATH: process.env.PATH ?? "", NODE_OPTIONS: `--require ${stub}`, STUB_RECORD: record, ...env },
    });
    const requests = existsSync(record)
      ? readFileSync(record, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, string>)
      : [];
    return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString(), requests };
  }

  it("asks the API for a GitHub token with the MCP token in a cloud session", () => {
    const run = runHelper({ DRAFT_API_BASE_URL: "https://api.draft.test", DRAFT_RUN_ID: RUN, DRAFT_MCP_TOKEN: "mcp-secret-value" });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("ghs_STUBTOKEN");
    expect(run.requests).toEqual([{ url: `https://api.draft.test/runs/${RUN}/tools/github.credential`, method: "POST", authorization: "Bearer mcp-secret-value" }]);
    expect(run.stderr).not.toContain("mcp-secret-value");
  });

  it("keeps the routine path: the callback URL and the run token", () => {
    const run = runHelper({ DRAFT_CALLBACK_URL: "https://callback.draft.test/sandbox/callback", DRAFT_RUN_ID: RUN, DRAFT_RUN_TOKEN: "run-secret-value" });
    expect(run.exitCode).toBe(0);
    expect(run.requests).toEqual([
      { url: `https://callback.draft.test/runs/${RUN}/tools/github.credential`, method: "POST", authorization: "Bearer run-secret-value" },
    ]);
  });

  it("fails without asking the backend when it has no token", () => {
    const run = runHelper({ DRAFT_API_BASE_URL: "https://api.draft.test", DRAFT_RUN_ID: RUN });
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("GitHub credentials unavailable");
    expect(run.requests).toEqual([]);
  });

  it("passes on why Draft refused, so the agent points the person at Draft and not at gh auth login", () => {
    const run = runHelper({ DRAFT_API_BASE_URL: "https://api.draft.test", DRAFT_RUN_ID: RUN, DRAFT_MCP_TOKEN: "mcp-secret-value", STUB_REFUSE: "github_not_connected" });
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("GitHub is not connected to this Draft workspace");
    expect(run.stdout).toBe("");
    const other = runHelper({ DRAFT_API_BASE_URL: "https://api.draft.test", DRAFT_RUN_ID: RUN, DRAFT_MCP_TOKEN: "mcp-secret-value", STUB_REFUSE: "something_new" });
    expect(other.stderr).toContain("server message");
  });

  it("fails without asking the backend when the run id could change the path", () => {
    const run = runHelper({ DRAFT_API_BASE_URL: "https://api.draft.test", DRAFT_RUN_ID: "../other", DRAFT_MCP_TOKEN: "mcp-secret-value" });
    expect(run.exitCode).toBe(1);
    expect(run.requests).toEqual([]);
  });
});
