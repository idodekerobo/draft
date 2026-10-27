import { describe, expect, it } from "bun:test";
import { InputDelivery, safePasteText, type DeliveryDeps, type PendingInput } from "./input-delivery";

const RULE = "─".repeat(100);
const READY = `${RULE}\n❯ \u001b[2mTry "fix"\u001b[0m\n${RULE}\n  ⏸ manual mode on\n`;
const TYPING = `${RULE}\n❯ half a thought\n${RULE}\n  ⏸ manual mode on\n`;
const PERMISSION = " Do you want to create a.txt?\n ❯ 1. Yes\n   3. No\n Esc to cancel · Tab to amend\n";

function setup(options: { pane?: string[]; pending?: PendingInput[] } = {}) {
  const log: string[] = [];
  const screens = [...(options.pane ?? [READY])];
  let pending = options.pending ?? [];
  const states = new Map(pending.map((p) => [p.id, p.state as string]));
  const failAt: { paste?: boolean; enter?: boolean } = {};

  const deps: DeliveryDeps = {
    fetchPending: async () => pending.filter((p) => ["queued", "delivering"].includes(states.get(p.id)!)).map((p) => ({ ...p, state: states.get(p.id) as "queued" | "delivering" })),
    setState: async (id, from, to, reason) => {
      if (!from.includes(states.get(id) as never)) return false;
      states.set(id, to);
      log.push(`${id}:${to}${reason ? `(${reason})` : ""}`);
      return true;
    },
    capture: async () => (screens.length > 1 ? screens.shift()! : screens[0]!),
    paste: async (text) => {
      if (failAt.paste) throw new Error("no pane");
      log.push(`paste:${JSON.stringify(text)}`);
    },
    pressEnter: async () => {
      if (failAt.enter) throw new Error("pane died");
      log.push("enter");
    },
    sleep: async () => {},
  };
  return { delivery: new InputDelivery(deps), log, states, failAt, setPane: (...s: string[]) => screens.splice(0, screens.length, ...s) };
}

const input = (id: string, text = id, state: "queued" | "delivering" = "queued"): PendingInput => ({ id, state, delivered_text: `[Dev via Draft] ${text}` });

describe("InputDelivery", () => {
  it("pastes into a ready pane, presses Enter and leaves the input delivering", async () => {
    const t = setup({ pane: [READY, TYPING, READY], pending: [input("a", "run tests")] });
    await t.delivery.tick();
    expect(t.log).toEqual(["a:delivering", 'paste:"[Dev via Draft] run tests"', "enter"]);
    expect(t.states.get("a")).toBe("delivering");
  });

  it("delivers the oldest input first and one per pass", async () => {
    const t = setup({ pane: [READY, READY], pending: [input("a"), input("b")] });
    await t.delivery.tick();
    expect(t.log.filter((l) => l.endsWith(":delivering"))).toEqual(["a:delivering"]);
  });

  it("keeps the input queued while a permission prompt is open and says why once", async () => {
    const t = setup({ pane: [PERMISSION], pending: [input("a")] });
    await t.delivery.tick();
    await t.delivery.tick();
    expect(t.log).toEqual(["a:queued(permission_prompt)"]);
    expect(t.states.get("a")).toBe("queued");
  });

  it("waits while the owner has text in the composer and never clears it", async () => {
    const t = setup({ pane: [TYPING], pending: [input("a")] });
    await t.delivery.tick();
    expect(t.log).toEqual(["a:queued(composer_busy)"]);
    t.setPane(READY);
    await t.delivery.tick();
    expect(t.log.slice(1)).toEqual(["a:delivering", 'paste:"[Dev via Draft] a"', "enter"]);
  });

  it("a crash before the paste fails the input", async () => {
    const t = setup({ pending: [input("a")] });
    t.failAt.paste = true;
    await t.delivery.tick();
    expect(t.log).toEqual(["a:delivering", "a:failed(pane_unavailable)"]);
  });

  it("a crash after the paste leaves the outcome uncertain", async () => {
    const t = setup({ pending: [input("a")] });
    t.failAt.enter = true;
    await t.delivery.tick();
    expect(t.log).toEqual(["a:delivering", 'paste:"[Dev via Draft] a"', "a:uncertain(delivery_interrupted)"]);
  });

  it("text that never leaves the composer is uncertain after one more Enter", async () => {
    const t = setup({ pane: [READY, TYPING], pending: [input("a")] });
    await t.delivery.tick();
    expect(t.log.filter((l) => l === "enter").length).toBe(2);
    expect(t.states.get("a")).toBe("uncertain");
  });

  it("after a restart a delivering input becomes uncertain and is not typed again", async () => {
    const t = setup({ pending: [input("a", "old", "delivering"), input("b", "new")] });
    await t.delivery.tick();
    expect(t.states.get("a")).toBe("uncertain");
    expect(t.log.some((l) => l.includes("old"))).toBe(false);
    expect(t.log).toContain('paste:"[Dev via Draft] new"');
  });

  it("recovers once, so a delivering input from this run is left alone", async () => {
    const t = setup({ pane: [READY, READY], pending: [input("a")] });
    await t.delivery.tick();
    t.setPane(TYPING);
    await t.delivery.tick();
    expect(t.states.get("a")).toBe("delivering");
  });

  it("sends multi-line text as it is", async () => {
    const t = setup({ pending: [input("a", "line one\n\nline two")] });
    await t.delivery.tick();
    expect(t.log[1]).toBe('paste:"[Dev via Draft] line one\\n\\nline two"');
  });

  it("does nothing when nothing is queued", async () => {
    const t = setup();
    await t.delivery.tick();
    expect(t.log).toEqual([]);
  });
});

describe("safePasteText", () => {
  it("removes escape sequences that could end a bracketed paste", () => {
    expect(safePasteText("a\u001b[201~ ls\u0000\r\nb")).toBe("a[201~ ls\nb");
  });
});
