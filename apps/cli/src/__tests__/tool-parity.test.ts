import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { TOOL_COMMANDS } from "draft-core/tool-commands";
import { makeHome, runCli } from "./helpers/cli-runner.ts";

const ANSI = /\u001b\[[0-9;]*m/g;

describe("the CLI offers a command for every tool it is meant to", () => {
  it("lists each command of the tool map in its help", async () => {
    const home = makeHome();
    const result = await runCli(["--help"], { home, apiUrl: "http://localhost:1" });
    expect(result.exitCode).toBe(0);
    const rows = result.stdout.replace(ANSI, "").split("\n").map((line) => line.trim());
    const missing = Object.values(TOOL_COMMANDS)
      .filter((path): path is string => path !== null)
      .filter((path) => {
        const [group, verb] = path.split(" ") as [string, string];
        return !rows.some((row) => row.startsWith(`${group} `) && row.includes(verb));
      });
    expect(missing).toEqual([]);
  });
});

/**
 * The only REST paths the CLI client may call directly. Every other call goes through a tool, so a person, an
 * agent and a run get the same contract. Each entry says why it stays outside the tools.
 */
const REST_PATHS_OUTSIDE_TOOLS: Record<string, string> = {
  "/tools": "the tools route itself",
  "/connections": "connecting with a key typed in the terminal, and Fireflies' check for an existing connection: the key goes from the person to the backend and never passes through a tool",
  "/github/install-sessions": "the GitHub install handoff: a browser step that the CLI polls",
  "/sessions/tokens": "minting and revoking ingest tokens for the session capture hooks: credentials, not capabilities",
  "/sessions": "older helpers for captured sessions that no command calls any more, kept until their tests go",
};

describe("the CLI client reaches the backend through tools", () => {
  const source = readFileSync(join(import.meta.dir, "..", "cloud-client.ts"), "utf8");
  const calls = [...source.matchAll(/\b(?:requestValue|authedFetch)(?:<[^>(]*>)?\(\s*([`"])([^`"]*)\1/g)].map((match) => match[2]!);
  const paths = calls.map((call) => call.split("${")[0]!.split("?")[0]!.replace(/\/$/, ""));

  it("finds the calls it checks", () => {
    expect(paths.length).toBeGreaterThan(5);
  });

  it("calls only paths that are listed with a reason", () => {
    const allowed = Object.keys(REST_PATHS_OUTSIDE_TOOLS);
    const unlisted = paths.filter((path) => !allowed.some((prefix) => path === prefix || path.startsWith(`${prefix}/`)));
    expect(unlisted).toEqual([]);
  });

  it("does not list a path that nothing calls", () => {
    const unused = Object.keys(REST_PATHS_OUTSIDE_TOOLS).filter((prefix) => !paths.some((path) => path === prefix || path.startsWith(`${prefix}/`)));
    expect(unused).toEqual([]);
  });
});
