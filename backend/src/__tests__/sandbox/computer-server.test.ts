import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createComputerServer, type ComputerConfig } from "../../sandbox/computer/server";

const TOKEN = "t".repeat(40);
let base: string;
let root: string;
let stateDir: string;
const servers: Array<ReturnType<typeof createComputerServer>> = [];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "computer-"));
  root = join(base, "workspace");
  stateDir = join(base, "state");
});
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  await rm(base, { recursive: true, force: true });
});

const server = (overrides: Partial<ComputerConfig> = {}) => {
  const created = createComputerServer({ token: TOKEN, root, stateDir, ...overrides });
  servers.push(created);
  return created;
};
const call = (s: ReturnType<typeof server>, method: string, path: string, body?: unknown, token = TOKEN) =>
  s.fetch(new Request(`http://computer${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));

async function finished(s: ReturnType<typeof server>, id: string, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const got = await call(s, "GET", `/jobs/${id}`);
    if (got.body.job.state !== "running") return got.body;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("job did not finish");
}

describe("the computer server", () => {
  it("answers only a request with the machine's token", async () => {
    const s = server();
    expect((await call(s, "GET", "/health", undefined, "wrong")).status).toBe(401);
    expect((await s.fetch(new Request("http://computer/health"))).status).toBe(401);
    expect((await call(s, "GET", "/health")).status).toBe(200);
  });

  it("runs a command as a job and returns its output and exit code", async () => {
    const s = server();
    const started = await call(s, "POST", "/jobs", { id: "job-aaaaaaaa", command: "echo hello; echo oops >&2; exit 3" });
    expect(started.status).toBe(201);
    const done = await finished(s, "job-aaaaaaaa");
    expect(done.job).toMatchObject({ state: "finished", exitCode: 3 });
    expect(done.output).toContain("hello");
    expect(done.output).toContain("oops");
  });

  it("attaches to a known job id and never runs the command again, and refuses the id for another command", async () => {
    const s = server();
    const command = "echo run >> count.txt";
    await call(s, "POST", "/jobs", { id: "job-bbbbbbbb", command });
    await finished(s, "job-bbbbbbbb");
    const again = await call(s, "POST", "/jobs", { id: "job-bbbbbbbb", command });
    expect(again.body).toMatchObject({ attached: true, job: { state: "finished" } });
    expect((await readFile(join(root, "count.txt"), "utf8")).trim().split("\n")).toHaveLength(1);
    expect((await call(s, "POST", "/jobs", { id: "job-bbbbbbbb", command: "echo other" })).status).toBe(409);
  });

  it("returns output from an offset, so a reader that lost its place continues without repeats", async () => {
    const s = server();
    await call(s, "POST", "/jobs", { id: "job-cccccccc", command: "printf 'abcdefghij'" });
    await finished(s, "job-cccccccc");
    const first = await call(s, "GET", "/jobs/job-cccccccc?from=0&limit=4");
    expect(first.body).toMatchObject({ output: "abcd", nextOffset: 4 });
    const rest = await call(s, "GET", `/jobs/job-cccccccc?from=${first.body.nextOffset}`);
    expect(rest.body).toMatchObject({ output: "efghij", nextOffset: 10 });
  });

  it("stops a job on cancel, and ends one that runs past its time", async () => {
    const s = server();
    await call(s, "POST", "/jobs", { id: "job-dddddddd", command: "sleep 30" });
    const cancelled = await call(s, "POST", "/jobs/job-dddddddd/cancel");
    expect(cancelled.body.job.state).toBe("cancelled");
    await call(s, "POST", "/jobs", { id: "job-eeeeeeee", command: "sleep 30", timeoutSeconds: 1 });
    expect((await finished(s, "job-eeeeeeee", 8000)).job.state).toBe("timeout");
  });

  it("keeps a finished job's result across a server restart, and reports a job that died with the server as lost", async () => {
    const first = server();
    await call(first, "POST", "/jobs", { id: "job-ffffffff", command: "echo kept" });
    await finished(first, "job-ffffffff");
    await mkdir(join(stateDir, "jobs"), { recursive: true });
    await writeFile(join(stateDir, "jobs", "job-gggggggg.json"), JSON.stringify({ id: "job-gggggggg", commandHash: "x", state: "running", exitCode: null, pid: 999999, startedAt: "2026-01-01T00:00:00Z", finishedAt: null }));

    const second = server();
    await second.recover();
    expect((await call(second, "GET", "/jobs/job-ffffffff")).body).toMatchObject({ job: { state: "finished", exitCode: 0 }, output: "kept\n" });
    expect((await call(second, "GET", "/jobs/job-gggggggg")).body.job.state).toBe("lost");
  });

  it("has a generation that stays the same across a restart, so a replaced volume can be told from a restart", async () => {
    const first = await call(server(), "GET", "/health");
    const second = await call(server(), "GET", "/health");
    expect(second.body.generation).toBe(first.body.generation);
    await rm(stateDir, { recursive: true, force: true });
    expect((await call(server(), "GET", "/health")).body.generation).not.toBe(first.body.generation);
  });

  it("cuts output at its limit and says so", async () => {
    const s = server({ maxOutputBytes: 100 });
    await call(s, "POST", "/jobs", { id: "job-hhhhhhhh", command: "head -c 1000 /dev/zero | tr '\\0' 'x'" });
    const done = await finished(s, "job-hhhhhhhh");
    expect(done.job.outputBytes).toBeLessThan(200);
    const all = await call(s, "GET", "/jobs/job-hhhhhhhh?from=0");
    expect(all.body.output).toContain("[output cut");
  });

  it("refuses a command directory outside the root", async () => {
    const s = server();
    expect((await call(s, "POST", "/jobs", { id: "job-iiiiiiii", command: "ls", cwd: ".." })).body.error).toBe("outside_root");
    expect((await call(s, "POST", "/jobs", { id: "job-jjjjjjjj", command: "ls", cwd: "/etc" })).body.error).toBe("outside_root");
  });
});

describe("the computer server's files", () => {
  it("writes, reads and lists files under the root", async () => {
    const s = server();
    expect((await call(s, "PUT", "/files", { path: "notes/a.txt", content: "hello" })).body).toMatchObject({ ok: true, replayed: false });
    expect((await call(s, "GET", "/files?path=notes/a.txt")).body).toMatchObject({ content: "hello", size: 5, truncated: false });
    expect((await call(s, "GET", "/list?path=notes")).body.entries).toEqual([{ name: "a.txt", type: "file", size: 5 }]);
  });

  it("writes once for one operation key, even when asked again with other content", async () => {
    const s = server();
    await call(s, "PUT", "/files", { path: "a.txt", content: "first", key: "op-1" });
    expect((await call(s, "PUT", "/files", { path: "a.txt", content: "second", key: "op-1" })).body.replayed).toBe(true);
    expect((await call(s, "GET", "/files?path=a.txt")).body.content).toBe("first");
  });

  it("refuses paths outside the root, absolute, climbing, or through a link", async () => {
    const s = server();
    await mkdir(root, { recursive: true });
    await writeFile(join(base, "secret.txt"), "s");
    await symlink(base, join(root, "escape"));
    for (const path of ["../secret.txt", "/etc/passwd", "escape/secret.txt"]) {
      expect((await call(s, "GET", `/files?path=${encodeURIComponent(path)}`)).body.error).toBe("outside_root");
      expect((await call(s, "PUT", "/files", { path, content: "x" })).body.error).toBe("outside_root");
    }
    expect((await call(s, "GET", "/list?path=..")).body.error).toBe("outside_root");
  });

  it("limits what it reads and what it writes", async () => {
    const s = server({ maxReadBytes: 10, maxWriteBytes: 20 });
    await call(s, "PUT", "/files", { path: "big.txt", content: "0123456789abcdef" });
    expect((await call(s, "GET", "/files?path=big.txt")).body).toMatchObject({ content: "0123456789", size: 16, truncated: true });
    expect((await call(s, "PUT", "/files", { path: "huge.txt", content: "x".repeat(21) })).status).toBe(413);
  });
});
