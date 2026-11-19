import { describe, expect, it } from "bun:test";
import { branchProblem, cloudRepoFromRemote, cloudStartFailure, repoProblem } from "./cloud-start";

describe("cloudRepoFromRemote", () => {
  it("turns a GitHub SSH remote into the https address", () => {
    expect(cloudRepoFromRemote("git@github.com:acme/marigold.git")).toBe("https://github.com/acme/marigold");
    expect(cloudRepoFromRemote("ssh://git@github.com/acme/marigold.git")).toBe("https://github.com/acme/marigold");
  });

  it("keeps an https address and trims it, and leaves other hosts for the check to refuse", () => {
    expect(cloudRepoFromRemote("  https://github.com/acme/marigold/ ")).toBe("https://github.com/acme/marigold");
    expect(cloudRepoFromRemote("git@gitlab.com:acme/marigold.git")).toBe("git@gitlab.com:acme/marigold.git");
  });
});

describe("repoProblem", () => {
  it("accepts a GitHub repository and says nothing while the field is empty", () => {
    expect(repoProblem("https://github.com/acme/marigold")).toBeNull();
    expect(repoProblem("https://github.com/acme/marigold.git")).toBeNull();
    expect(repoProblem("")).toBeNull();
  });

  it("refuses other hosts, dot names and a missing repository", () => {
    expect(repoProblem("https://gitlab.com/acme/marigold")).toContain("GitHub repository address");
    expect(repoProblem("https://github.com/acme/..")).toContain("GitHub repository address");
    expect(repoProblem("https://github.com/acme")).toContain("GitHub repository address");
    expect(repoProblem("https://github.com/acme/.git")).toContain("GitHub repository address");
  });
});

describe("branchProblem", () => {
  it("accepts ordinary branch names, including slashes", () => {
    expect(branchProblem("main")).toBeNull();
    expect(branchProblem("feature/login-2")).toBeNull();
    expect(branchProblem("")).toBeNull();
  });

  it("refuses spaces, options and names git would not take", () => {
    expect(branchProblem("bad branch")).toBe("Use a branch name, such as main.");
    expect(branchProblem("-rf")).toBe("Use a branch name, such as main.");
    expect(branchProblem("a..b")).toBe("Use a branch name, such as main.");
    expect(branchProblem("topic.lock")).toBe("Use a branch name, such as main.");
  });
});

describe("cloudStartFailure", () => {
  it("places each known code under the field it is about", () => {
    expect(cloudStartFailure("invalid_seed").field).toBe("repo");
    expect(cloudStartFailure("invalid_network").field).toBe("network");
    expect(cloudStartFailure("harness_not_supported").field).toBe("agent");
    expect(cloudStartFailure("claude_not_connected").field).toBe("general");
  });

  it("gives an unknown code the general message", () => {
    expect(cloudStartFailure("request_failed_500")).toEqual({ field: "general", message: "The cloud session could not start. Try again." });
  });
});
