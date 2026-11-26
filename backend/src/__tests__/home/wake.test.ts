import { afterEach, describe, expect, it } from "bun:test";
import { setHomeWaker, wakingHome } from "../../home/runtime/wake";

afterEach(() => setHomeWaker(undefined));
const request = (sessionId: string) => ({ params: { sessionId } }) as never;

describe("waking Home after a saved input", () => {
  it("wakes Home for the session after a route answers well, and passes the answer through", async () => {
    const woken: string[] = [];
    setHomeWaker(async (id) => void woken.push(id));
    const response = await wakingHome(async () => Response.json({ ok: true }, { status: 201 }))(request("s1"));
    expect(response.status).toBe(201);
    await Promise.resolve();
    expect(woken).toEqual(["s1"]);
  });

  it("does not wake Home when the route refused", async () => {
    const woken: string[] = [];
    setHomeWaker(async (id) => void woken.push(id));
    await wakingHome(async () => Response.json({ error: "x" }, { status: 404 }))(request("s1"));
    expect(woken).toEqual([]);
  });

  it("does nothing, and does not fail, when Home is off or the wake throws", async () => {
    expect((await wakingHome(async () => new Response("ok"))(request("s1"))).status).toBe(200);
    setHomeWaker(async () => {
      throw new Error("boom");
    });
    expect((await wakingHome(async () => new Response("ok"))(request("s1"))).status).toBe(200);
  });
});
