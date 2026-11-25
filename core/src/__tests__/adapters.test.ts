import { describe, expect, it } from "bun:test";
import { ADAPTERS, HARNESSES, adapterSupportsTarget, getAdapter, interactiveAdapterFor, isAdapterId, requireAdapter, requireInteractiveAdapter, routineAdapterFor } from "../harnesses";
import { cloudNativeToolsFor, isCloudNativeTool, isNativeTool } from "../run-spec";

describe("adapter registry", () => {
  it("lists the adapters, each under its harness", () => {
    expect(ADAPTERS.map((adapter) => adapter.id)).toEqual(["claude-terminal", "claude-print", "codex-app-server", "codex-exec", "pi-durable-sdk"]);
    for (const harness of HARNESSES) expect(harness.adapters.every((adapter) => adapter.harness === harness.id)).toBe(true);
  });

  it("finds an adapter by id, and fails for a missing or unknown one", () => {
    expect(getAdapter("codex-exec")?.harness).toBe("codex");
    expect(isAdapterId("claude-print")).toBe(true);
    expect(isAdapterId("future")).toBe(false);
    expect(getAdapter(undefined)).toBeNull();
    expect(() => requireAdapter("future")).toThrow("Unknown adapter");
    expect(() => requireAdapter(undefined)).toThrow("Unknown adapter");
  });

  it("picks the live-session and routine adapter of a harness", () => {
    expect(interactiveAdapterFor("claude")?.id).toBe("claude-terminal");
    expect(interactiveAdapterFor("codex")?.id).toBe("codex-app-server");
    expect(routineAdapterFor("claude")?.id).toBe("claude-print");
    expect(routineAdapterFor("codex")?.id).toBe("codex-exec");
    expect(interactiveAdapterFor("future")).toBeNull();
    expect(interactiveAdapterFor(undefined)).toBeNull();
    expect(() => requireInteractiveAdapter(undefined)).toThrow("No adapter");
  });

  it("keeps Codex off the sandbox for live sessions, and Claude on it", () => {
    expect(adapterSupportsTarget(requireAdapter("claude-terminal"), "sandbox")).toBe(true);
    expect(adapterSupportsTarget(requireAdapter("codex-app-server"), "sandbox")).toBe(false);
    expect(adapterSupportsTarget(requireAdapter("claude-terminal"), "backend")).toBe(false);
  });

  it("registers the Home adapter for the backend target, without a launcher", () => {
    const pi = requireAdapter("pi-durable-sdk");
    expect(pi.targets).toEqual(["backend"]);
    expect(pi.eventPath).toBe("events");
    expect(pi.launchable).toBe(false);
    expect(ADAPTERS.filter((adapter) => adapter.id !== "pi-durable-sdk").every((adapter) => adapter.launchable && adapter.eventPath === "lines")).toBe(true);
  });

  it("gives steer to Codex live sessions only", () => {
    expect(requireAdapter("codex-app-server").capabilities.steer).toBe(true);
    expect(requireAdapter("claude-terminal").capabilities.steer).toBe(false);
  });

  it("keeps the cloud tool lists the harnesses had before", () => {
    expect(cloudNativeToolsFor("claude")).toEqual(["Read", "Glob", "Grep", "WebSearch", "WebFetch", "Bash", "Edit", "Write"]);
    expect(cloudNativeToolsFor("codex")).toEqual(["shell", "web_search"]);
    expect(cloudNativeToolsFor("future")).toEqual([]);
    expect(isCloudNativeTool({ harness: "codex", tool: "apply_patch" })).toBe(false);
    expect(isNativeTool("codex", "apply_patch")).toBe(true);
    expect(isNativeTool("claude", "shell")).toBe(false);
  });
});
