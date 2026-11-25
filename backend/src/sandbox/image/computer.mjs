// @bun
// src/sandbox/computer/server.ts
import { createHash, randomUUID, timingSafeEqual } from "crypto";
import { mkdir, readdir, readFile, realpath, stat, writeFile, open } from "fs/promises";
import { dirname, join, resolve, sep } from "path";
var ID = /^[A-Za-z0-9_-]{8,64}$/;
var sha = (value) => createHash("sha256").update(value).digest("hex");
var json = (body, status = 200) => Response.json(body, { status });
var refuse = (code, status, message) => json({ ok: false, error: code, ...message ? { message } : {} }, status);
function createComputerServer(input) {
  const config = { maxOutputBytes: 2000000, maxReadBytes: 1e6, maxWriteBytes: 5000000, maxJobSeconds: 3600, pageBytes: 64000, ...input };
  const jobsDir = join(config.stateDir, "jobs");
  const opsDir = join(config.stateDir, "ops");
  const tokenDigest = createHash("sha256").update(config.token).digest();
  const live = new Map;
  let generation;
  const recordPath = (id) => join(jobsDir, `${id}.json`);
  const outputPath = (id) => join(jobsDir, `${id}.out`);
  async function ready() {
    await mkdir(jobsDir, { recursive: true });
    await mkdir(opsDir, { recursive: true });
    await mkdir(config.root, { recursive: true });
    const file = join(config.stateDir, "generation");
    try {
      generation = (await readFile(file, "utf8")).trim();
    } catch {
      generation = randomUUID();
      await writeFile(file, generation);
    }
  }
  const readRecord = async (id) => {
    try {
      return JSON.parse(await readFile(recordPath(id), "utf8"));
    } catch {
      return null;
    }
  };
  const saveRecord = (record) => writeFile(recordPath(record.id), JSON.stringify(record));
  const outputSize = async (id) => {
    try {
      return (await stat(outputPath(id))).size;
    } catch {
      return 0;
    }
  };
  const view = async (record) => ({ id: record.id, state: record.state, exitCode: record.exitCode, startedAt: record.startedAt, finishedAt: record.finishedAt, outputBytes: await outputSize(record.id), generation });
  async function inside(path) {
    const root = await realpath(config.root);
    const target = resolve(root, path || ".");
    let probe = target;
    while (true) {
      try {
        const real = await realpath(probe);
        const full = join(real, target.slice(probe.length));
        return full === root || full.startsWith(root + sep) ? full : null;
      } catch {
        const parent = dirname(probe);
        if (parent === probe)
          return null;
        probe = parent;
      }
    }
  }
  async function finish(record, state, exitCode) {
    const current = await readRecord(record.id) ?? record;
    if (current.state !== "running")
      return;
    await saveRecord({ ...current, state, exitCode, pid: null, finishedAt: new Date().toISOString() });
  }
  async function startJob(record, command, cwd, seconds) {
    const out = await open(outputPath(record.id), "a");
    let written = 0;
    const append = async (chunk) => {
      if (written >= config.maxOutputBytes)
        return;
      const room = config.maxOutputBytes - written;
      const piece = chunk.length > room ? chunk.slice(0, room) : chunk;
      written += piece.length;
      await out.write(piece);
      if (chunk.length > room)
        await out.write(`
[output cut: limit reached]
`);
    };
    const child = Bun.spawn(["bash", "-lc", command], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", detached: true, env: { ...process.env, DRAFT_COMPUTER_JOB: record.id } });
    await saveRecord({ ...record, pid: child.pid });
    const pump = async (stream) => {
      for await (const chunk of stream)
        await append(chunk);
    };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      kill(child.pid);
    }, seconds * 1000);
    live.set(record.id, { kill: (signal) => kill(child.pid, signal), timer });
    (async () => {
      await Promise.all([pump(child.stdout), pump(child.stderr)]);
      const code = await child.exited;
      clearTimeout(timer);
      live.delete(record.id);
      await out.close();
      const cancelled = (await readRecord(record.id))?.state === "cancelled";
      if (!cancelled)
        await finish(record, timedOut ? "timeout" : "finished", timedOut ? null : code);
    })();
  }
  function kill(pid, signal = 15) {
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {}
    }
  }
  const alive = (pid) => {
    if (!pid)
      return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  async function recover() {
    await ready();
    for (const name of await readdir(jobsDir)) {
      if (!name.endsWith(".json"))
        continue;
      const record = await readRecord(name.slice(0, -5));
      if (record?.state !== "running" || live.has(record.id))
        continue;
      if (alive(record.pid)) {
        const watch = setInterval(async () => {
          if (alive(record.pid))
            return;
          clearInterval(watch);
          await finish(record, "lost", null);
        }, 1000);
        watch.unref?.();
      } else {
        await finish(record, "lost", null);
      }
    }
  }
  function authorized(request) {
    const header = request.headers.get("authorization") ?? "";
    const given = createHash("sha256").update(header.startsWith("Bearer ") ? header.slice(7) : "").digest();
    return timingSafeEqual(given, tokenDigest);
  }
  async function handle(request) {
    if (!authorized(request))
      return refuse("unauthorized", 401);
    if (!generation)
      await ready();
    const url = new URL(request.url);
    const { pathname } = url;
    if (pathname === "/health" && request.method === "GET")
      return json({ ok: true, generation });
    if (pathname === "/jobs" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      if (!body?.id || !ID.test(body.id))
        return refuse("invalid_job_id", 400);
      if (typeof body.command !== "string" || !body.command.trim())
        return refuse("invalid_command", 400);
      const hash = sha(body.command);
      const existing = await readRecord(body.id);
      if (existing) {
        if (existing.commandHash !== hash)
          return refuse("job_id_reused", 409);
        return json({ ok: true, attached: true, job: await view(existing) });
      }
      const cwd = await inside(body.cwd ?? ".");
      if (!cwd)
        return refuse("outside_root", 400);
      await mkdir(cwd, { recursive: true });
      const seconds = Math.min(Math.max(Math.floor(body.timeoutSeconds ?? 600), 1), config.maxJobSeconds);
      const record = { id: body.id, commandHash: hash, state: "running", exitCode: null, pid: null, startedAt: new Date().toISOString(), finishedAt: null };
      await saveRecord(record);
      await startJob(record, body.command, cwd, seconds);
      return json({ ok: true, attached: false, job: await view(await readRecord(body.id) ?? record) }, 201);
    }
    const job = /^\/jobs\/([A-Za-z0-9_-]{8,64})(\/cancel)?$/.exec(pathname);
    if (job) {
      const id = job[1];
      const record = await readRecord(id);
      if (!record)
        return refuse("job_not_found", 404);
      if (job[2] && request.method === "POST") {
        if (record.state === "running") {
          await saveRecord({ ...record, state: "cancelled", finishedAt: new Date().toISOString() });
          live.get(id)?.kill();
          setTimeout(() => live.get(id)?.kill(9), 2000).unref?.();
        }
        return json({ ok: true, job: await view(await readRecord(id) ?? record) });
      }
      if (!job[2] && request.method === "GET") {
        const from = Math.max(Number(url.searchParams.get("from") ?? 0) || 0, 0);
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? config.pageBytes) || config.pageBytes, 1), config.pageBytes);
        const size = await outputSize(id);
        let output = "";
        let next = from;
        if (size > from) {
          const handle2 = await open(outputPath(id), "r");
          try {
            const buffer = Buffer.alloc(Math.min(limit, size - from));
            const { bytesRead } = await handle2.read(buffer, 0, buffer.length, from);
            output = buffer.subarray(0, bytesRead).toString("utf8");
            next = from + bytesRead;
          } finally {
            await handle2.close();
          }
        }
        return json({ ok: true, job: await view(record), from, nextOffset: next, output });
      }
    }
    if (pathname === "/files" && request.method === "GET") {
      const path = await inside(url.searchParams.get("path") ?? "");
      if (!path)
        return refuse("outside_root", 400);
      const info = await stat(path).catch(() => null);
      if (!info)
        return refuse("not_found", 404);
      if (!info.isFile())
        return refuse("not_a_file", 400);
      const handle2 = await open(path, "r");
      try {
        const buffer = Buffer.alloc(Math.min(info.size, config.maxReadBytes));
        const { bytesRead } = await handle2.read(buffer, 0, buffer.length, 0);
        return json({ ok: true, content: buffer.subarray(0, bytesRead).toString("utf8"), size: info.size, truncated: info.size > bytesRead });
      } finally {
        await handle2.close();
      }
    }
    if (pathname === "/files" && request.method === "PUT") {
      const body = await request.json().catch(() => null);
      if (!body || typeof body.path !== "string" || typeof body.content !== "string")
        return refuse("invalid_body", 400);
      if (Buffer.byteLength(body.content) > config.maxWriteBytes)
        return refuse("too_large", 413);
      const path = await inside(body.path);
      if (!path || path === await realpath(config.root))
        return refuse("outside_root", 400);
      const keyFile = body.key ? join(opsDir, sha(body.key)) : null;
      if (keyFile && await stat(keyFile).catch(() => null))
        return json({ ok: true, replayed: true });
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body.content);
      if (keyFile)
        await writeFile(keyFile, "");
      return json({ ok: true, replayed: false, bytes: Buffer.byteLength(body.content) });
    }
    if (pathname === "/list" && request.method === "GET") {
      const path = await inside(url.searchParams.get("path") ?? "");
      if (!path)
        return refuse("outside_root", 400);
      const names = await readdir(path, { withFileTypes: true }).catch(() => null);
      if (!names)
        return refuse("not_found", 404);
      const entries = await Promise.all(names.slice(0, 500).map(async (entry) => ({ name: entry.name, type: entry.isDirectory() ? "dir" : entry.isSymbolicLink() ? "link" : "file", size: entry.isFile() ? (await stat(join(path, entry.name)).catch(() => null))?.size ?? 0 : 0 })));
      return json({ ok: true, entries, truncated: names.length > 500 });
    }
    return refuse("not_found", 404);
  }
  return {
    fetch: (request) => handle(request).catch((error) => refuse("server_error", 500, error instanceof Error ? error.message : String(error))),
    recover,
    async close() {
      for (const [, job] of live) {
        clearTimeout(job.timer);
      }
    }
  };
}

// src/sandbox/computer.ts
var token = process.env.DRAFT_COMPUTER_TOKEN;
if (!token || token.length < 32) {
  console.error("[computer] fatal: DRAFT_COMPUTER_TOKEN must be at least 32 characters");
  process.exit(1);
}
var root = process.env.DRAFT_COMPUTER_ROOT ?? "/data/workspace";
var server = createComputerServer({ token, root, stateDir: process.env.DRAFT_COMPUTER_STATE ?? "/data/.draft/computer" });
await server.recover();
Bun.serve({ port: Number(process.env.DRAFT_COMPUTER_PORT ?? 8080), hostname: "0.0.0.0", idleTimeout: 120, fetch: server.fetch });
console.log("[computer] listening");
