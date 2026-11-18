import { chmodSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { randomBytes } from "crypto";
import { GUI_PATH } from "../../../exec";

const TOKEN_DIR = `${process.env.HOME}/.draft/host/codex`;

export interface AppServer {
  /** Where the app server listens, on this computer only. */
  url: string;
  /** The capability token every client must send. */
  token: string;
  stop(): void;
  /** Resolves when the process ends. */
  exited: Promise<number>;
}

/** A free loopback port. The server is started on it a moment later. */
async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const { port } = probe;
  await probe.stop(true);
  return port as number;
}

/**
 * Starts `codex app-server` on a loopback WebSocket guarded by a random token. The terminal app and Draft both
 * connect to it, so they see the same thread. It is a child of this app and ends with it.
 */
export async function startAppServer(codexBin: string, id: string): Promise<AppServer> {
  const port = await freePort();
  const token = randomBytes(24).toString("hex");
  mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
  const tokenPath = `${TOKEN_DIR}/${id}-${port}.token`;
  writeFileSync(tokenPath, token, { mode: 0o600 });
  chmodSync(tokenPath, 0o600);

  const proc = Bun.spawn(
    [codexBin, "app-server", "--listen", `ws://127.0.0.1:${port}`, "--ws-auth", "capability-token", "--ws-token-file", tokenPath],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore", env: { ...process.env, PATH: GUI_PATH } },
  );
  const exited = proc.exited.finally(() => rmSync(tokenPath, { force: true }));
  return { url: `ws://127.0.0.1:${port}`, token, stop: () => proc.kill(), exited };
}
