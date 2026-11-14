import { describe, expect, it } from "bun:test";
import { githubPullRequestFacts, githubPushFacts, linearIssueFacts } from "../../routines/event-facts";

const asText = (facts: Array<{ label: string; value: string }>) => facts.map((fact) => `${fact.label}: ${fact.value}`).join("\n");

describe("event facts", () => {
  it("gives a pull request's repo, number, link, refs and size, and leaves out what GitHub did not send", () => {
    const text = asText(githubPullRequestFacts({
      action: "closed",
      repository: { full_name: "acme/app" },
      pull_request: {
        node_id: "n", number: 42, title: "Fix", body: null, state: "closed", draft: false, updated_at: "2026-11-14T00:00:00Z", html_url: "https://github.com/acme/app/pull/42",
        user: { login: "uzo" }, base: { ref: "main", sha: "b".repeat(40) }, head: { ref: "fix", sha: "h".repeat(40) }, labels: [],
        merged: true, merge_commit_sha: "m".repeat(40), changed_files: 3, additions: 10, deletions: 2,
      },
    }));
    expect(text).toContain("Repository: acme/app\nPull request: #42\nURL: https://github.com/acme/app/pull/42");
    expect(text).toContain("Branches: main ← fix");
    expect(text).toContain("Size: 3 files, +10 −2");
    expect(text).toContain(`Merge commit: ${"m".repeat(40)}`);
    expect(text).not.toContain("Merged at");
  });

  it("lists only the newest commits of a big push, one line each, and keeps the compare link", () => {
    const commits = Array.from({ length: 25 }, (_, index) => ({
      id: `${index}`.padStart(40, "0"), message: `Commit ${index}\n\nlong body`, url: "u", timestamp: "t", author: { name: "Uzo", username: "uzo" }, modified: ["a.ts"],
    }));
    const text = asText(githubPushFacts({ ref: "refs/heads/main", compare: "https://github.com/acme/app/compare/a...b", repository: { full_name: "acme/app", default_branch: "main" }, commits }));
    expect(text).toContain("Branch: main");
    expect(text).toContain("Compare: https://github.com/acme/app/compare/a...b");
    expect(text).toContain("Commits: 25 (newest 20 below)");
    expect(text).toContain("Commit 24 (uzo, 1 files)");
    expect(text).not.toContain("Commit 4 ");
    expect(text).not.toContain("long body");
  });

  it("gives a Linear issue's identifier, link, team and state", () => {
    const text = asText(linearIssueFacts({
      type: "Issue", action: "update",
      data: { id: "i-1", identifier: "ENG-7", url: "https://linear.app/acme/issue/ENG-7", team: { name: "Engineering" }, state: { name: "Done" }, labels: [{ name: "bug" }] },
    }));
    expect(text).toBe("Issue: ENG-7\nURL: https://linear.app/acme/issue/ENG-7\nTeam: Engineering\nState: Done\nLabels: bug\nLinear issue id: i-1");
  });
});
