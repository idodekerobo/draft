import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";

const MACHINE_ID_PATH = `${process.env.HOME}/.draft/host-id`;

/** Stable id for this machine, made on first use. */
export function getHostMachineId(path = MACHINE_ID_PATH): string {
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8").trim();
    if (existing) return existing;
  }
  const id = crypto.randomUUID();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${id}\n`);
  return id;
}
