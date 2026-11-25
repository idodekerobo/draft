import { describe, expect, it } from "bun:test";
import { displayHostName } from "./host-name";
import { isDraftCloudSession, isHostSession, isSandboxSession } from "./place";

describe("session place", () => {
  it("treats a host target as This computer, and a sandbox or backend target as Draft Cloud", () => {
    expect([isHostSession({ execution_target: "host" }), isSandboxSession({ execution_target: "host" }), isDraftCloudSession({ execution_target: "host" })]).toEqual([true, false, false]);
    expect([isHostSession({ execution_target: "sandbox" }), isSandboxSession({ execution_target: "sandbox" }), isDraftCloudSession({ execution_target: "sandbox" })]).toEqual([false, true, true]);
    expect([isHostSession({ execution_target: "backend" }), isSandboxSession({ execution_target: "backend" }), isDraftCloudSession({ execution_target: "backend" })]).toEqual([false, false, true]);
  });

  it("treats a session with no target, such as one from an older server, as a computer session", () => {
    expect([isHostSession({}), isSandboxSession({}), isDraftCloudSession({})]).toEqual([false, false, false]);
  });

  it("labels a backend session Draft Cloud, as a sandbox session", () => {
    expect(displayHostName({ host_name: null, execution_target: "backend" })).toBe("Draft Cloud");
    expect(displayHostName({ host_name: null, execution_target: "sandbox" })).toBe("Draft Cloud");
    expect(displayHostName({ host_name: "Maya's MacBook", execution_target: "host" })).toBe("Maya's MacBook");
  });
});
