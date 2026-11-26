import { describe, expect, it } from "bun:test";
import { permissionsBeyondRoutine } from "../routine-steps";
import { CAPTURE_PERMISSIONS, DRAFT_TOOLS, ORGANIZE_PERMISSIONS, RECONCILE_PERMISSIONS, SYNTHESIS_PERMISSIONS, SYNTHESIS_READ_PERMISSIONS, type AnyDraftToolPermission } from "../tools";

const names = (permissions: ReadonlyArray<AnyDraftToolPermission>): string[] => permissions.map((permission) => permission.tool).sort();

const READ = ["context.list", "context.read", "skills.list", "skills.read", "sources.list", "sources.read", "sources.search"];
const PEOPLE = ["people.approve", "people.create", "people.find", "people.notification_status", "people.reject", "people.update"];

describe("synthesis permissions", () => {
  it("gives the whole run the read tools, context.write and the people tools, with notify limited to members", () => {
    expect(names(SYNTHESIS_PERMISSIONS)).toEqual([...READ, "context.write", ...PEOPLE, "people.notify"].sort());
    expect(SYNTHESIS_PERMISSIONS.find((permission) => permission.tool === "people.notify")).toEqual({ tool: "people.notify", limits: { recipients: "members" } });
    expect(new Set(names(SYNTHESIS_PERMISSIONS)).size).toBe(SYNTHESIS_PERMISSIONS.length);
  });

  it("gives capture the read tools only", () => {
    expect(names(CAPTURE_PERMISSIONS)).toEqual(READ);
    expect(CAPTURE_PERMISSIONS).toBe(SYNTHESIS_READ_PERMISSIONS);
  });

  it("gives reconcile the read tools and context.write", () => {
    expect(names(RECONCILE_PERMISSIONS)).toEqual([...READ, "context.write"].sort());
  });

  it("gives organize the read tools, context.write and the people tools, without notify", () => {
    expect(names(ORGANIZE_PERMISSIONS)).toEqual([...READ, "context.write", ...PEOPLE].sort());
    expect(names(ORGANIZE_PERMISSIONS)).not.toContain("people.notify");
  });

  it("keeps every step inside the synthesis run's own permissions", () => {
    for (const list of [CAPTURE_PERMISSIONS, RECONCILE_PERMISSIONS, ORGANIZE_PERMISSIONS]) {
      expect(permissionsBeyondRoutine({ permissions: [...list] }, SYNTHESIS_PERMISSIONS)).toEqual([]);
    }
  });

  it("gives no step a message, routine or connection tool, or any tool that asks a person for input", () => {
    const forbidden = /^(routines|connections|github|sessions|skills\.(add|update|delete))\.|^people\.notify$|input/;
    for (const list of [CAPTURE_PERMISSIONS, RECONCILE_PERMISSIONS, ORGANIZE_PERMISSIONS]) {
      expect(names(list).filter((name) => forbidden.test(name))).toEqual([]);
    }
    // No Draft tool creates an input request today. If one is added, this fails until it is kept out of the steps on purpose.
    expect(DRAFT_TOOLS.map((tool) => tool.name).filter((name) => /input/.test(name))).toEqual([]);
  });
});
