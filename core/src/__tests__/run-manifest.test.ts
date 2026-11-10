import { describe, expect, it } from "bun:test";
import { parseRunnerManifest, validateRunnerManifest, type RunnerManifest } from "../run-manifest";

const CALLBACK = "https://api.example.com/sandbox/callback";
const MCP_URL = "https://api.example.com/runs/11111111-1111-4111-8111-111111111111/mcp";
const checks = { callbackUrl: CALLBACK };

const good: RunnerManifest = {
  version: 1,
  harness: "claude",
  model: null,
  prompt: { kind: "file", path: "/run/input/prompt.md" },
  tools: { native: ["Read", "Glob"], draftMcpUrl: null },
  output: { kind: "stream" },
  timeoutSeconds: 900,
};
const structured: RunnerManifest["output"] = { kind: "structured", schemaPath: "/run/input/output-schema.json" };
const parse = (value: unknown) => validateRunnerManifest(value, checks);

describe("the run manifest", () => {
  it("accepts a complete manifest, from JSON text too", () => {
    expect(parse(good)).toEqual(good);
    expect(parseRunnerManifest(JSON.stringify(good), checks)).toEqual(good);
  });

  it("refuses text that is not JSON", () => {
    expect(() => parseRunnerManifest("{nope", checks)).toThrow("valid JSON");
  });

  it("refuses a key it does not know, at any level", () => {
    expect(() => parse({ ...good, extra: 1 })).toThrow("unknown key in manifest: extra");
    expect(() => parse({ ...good, tools: { ...good.tools, shell: true } })).toThrow("unknown key in tools");
    expect(() => parse({ ...good, prompt: { kind: "file", path: "/run/input/prompt.md", more: 1 } })).toThrow("unknown key in prompt");
    expect(() => parse({ ...good, output: { kind: "stream", flag: 1 } })).toThrow("unknown key in output");
  });

  it("refuses a bad version, harness, model and timeout", () => {
    expect(() => parse({ ...good, version: 2 })).toThrow("version");
    expect(() => parse({ ...good, harness: "gemini" })).toThrow("harness");
    expect(() => parse({ ...good, model: "bad model; rm -rf" })).toThrow("model");
    expect(() => parse({ ...good, timeoutSeconds: 0 })).toThrow("timeoutSeconds");
    expect(() => parse({ ...good, timeoutSeconds: 4000 })).toThrow("timeoutSeconds");
    expect(() => parse({ ...good, timeoutSeconds: 1.5 })).toThrow("timeoutSeconds");
  });

  it("refuses a file outside the input folder", () => {
    expect(() => parse({ ...good, prompt: { kind: "file", path: "/etc/passwd" } })).toThrow("must be a file under");
    expect(() => parse({ ...good, prompt: { kind: "file", path: "/run/input/../../etc/passwd" } })).toThrow("must be a file under");
    expect(() => parse({ ...good, output: { kind: "structured", schemaPath: "/tmp/schema.json" } })).toThrow("must be a file under");
  });

  it("refuses a native tool the harness may not use", () => {
    expect(() => parse({ ...good, tools: { native: ["Bash"], draftMcpUrl: null } })).toThrow("tools.native");
    expect(() => parse({ ...good, harness: "codex", tools: { native: ["Read"], draftMcpUrl: null } })).toThrow("tools.native");
  });

  it("refuses a tool server that is not HTTPS on the callback host", () => {
    expect(() => parse({ ...good, tools: { native: ["Read"], draftMcpUrl: "https://evil.example.net/mcp" } })).toThrow("callback host");
    expect(() => parse({ ...good, tools: { native: ["Read"], draftMcpUrl: "http://api.example.com/mcp" } })).toThrow("callback host");
    expect(parse({ ...good, tools: { native: ["Read"], draftMcpUrl: MCP_URL } }).tools.draftMcpUrl).toBe(MCP_URL);
  });

  it("keeps Codex to one streamed prompt", () => {
    const codex = { ...good, harness: "codex", tools: { native: ["shell"], draftMcpUrl: null } };
    expect(() => parse({ ...codex, output: structured })).toThrow("codex runs stream");
    expect(() => parse({ ...codex, prompt: { kind: "items", manifestPath: "/run/input/manifest.json" } })).toThrow("codex runs stream");
  });
});
