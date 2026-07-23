import { describe, expect, it } from "bun:test";
import { resolveBunExecutable, resolveRuntimeEntrypoint, runtimeCommand } from "../runtime";

describe("runtime entrypoint resolution", () => {
  it("prefers bundled JS, then TS, then shell", () => {
    const files = new Set(["/x/task.js", "/x/task.ts", "/x/task.sh"]);
    expect(resolveRuntimeEntrypoint("/x/task", { exists: (path) => files.has(path) }))
      .toEqual({ path: "/x/task.js", kind: "js" });
    files.delete("/x/task.js");
    expect(resolveRuntimeEntrypoint("/x/task", { exists: (path) => files.has(path) })?.kind).toBe("ts");
    files.delete("/x/task.ts");
    expect(resolveRuntimeEntrypoint("/x/task", { exists: (path) => files.has(path) })?.kind).toBe("sh");
  });

  it("prefers Draft's installed Bun and uses bash only for shell entrypoints", () => {
    const installedBun = "/Users/test/.draft/bin/bun";
    const exists = (path: string) => path === installedBun;
    expect(resolveBunExecutable({ home: "/Users/test", path: "", exists })).toBe(installedBun);
    expect(runtimeCommand({ path: "/x/task.js", kind: "js" }, ["arg"], { home: "/Users/test", path: "", exists }))
      .toEqual([installedBun, "run", "/x/task.js", "arg"]);
    expect(runtimeCommand({ path: "/x/task.sh", kind: "sh" }, ["arg"], { exists: () => false }))
      .toEqual(["bash", "/x/task.sh", "arg"]);
  });
});
