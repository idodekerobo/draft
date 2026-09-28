// desktop/scripts/lib/patch-minos.ts — lower a Mach-O binary's macOS deployment floor
//
// Why this exists: several binaries that ship inside Draft.app carry a `minos`
// (LC_BUILD_VERSION) far higher than anything they actually require:
//
//   Contents/MacOS/launcher (outer wrapper)  minos 14.8.5  — built natively by
//     Electrobun with no -Dtarget on arm64, so it inherits the *build machine's*
//     OS version as the floor.
//   Contents/MacOS/libasar.dylib             minos 14.8.3  — prebuilt zig-asar
//   Contents/MacOS/zig-zstd                  minos 14.8.3  — prebuilt zig-zstd
//
// dyld refuses to load a binary whose minos exceeds the running OS, so those
// values are a hard launch gate on macOS 14.x — even though all three link only
// /usr/lib/libSystem.B.dylib. libNativeWrapper.dylib (real WebKit/Cocoa/Metal
// framework deps) already requires 14.0, so 14.0 is the honest floor for the app.
//
// Lowering minos can only ever *widen* the set of machines that will load a
// binary; it has no effect on users already on newer macOS.
//
// Shared by scripts/postbuild.ts (inner bundle) and scripts/postwrap.ts (outer
// wrapper bundle). Both run before Electrobun codesigns their respective bundle,
// so the signature stays valid.

import { execFileSync } from "child_process";
import { existsSync, statSync } from "fs";

/** The macOS deployment floor every patched binary is normalized to. */
export const TARGET_MINOS = "14.0";

interface BuildVersion {
  minos: string;
  sdk: string;
}

function fatal(msg: string, label: string): never {
  console.error(`[patch-minos] FATAL (${label}): ${msg}`);
  process.exit(1);
}

/** "14.8.5" → [14, 8, 5]; missing components are zero-filled. */
function parseVersion(v: string): [number, number, number] {
  const parts = v.split(".").map((n) => Number.parseInt(n, 10));
  if (parts.some((n) => Number.isNaN(n))) return [NaN, NaN, NaN];
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/** a <= b */
function lte(a: string, b: string): boolean {
  const [a0, a1, a2] = parseVersion(a);
  const [b0, b1, b2] = parseVersion(b);
  if (a0 !== b0) return a0 < b0;
  if (a1 !== b1) return a1 < b1;
  return a2 <= b2;
}

/**
 * Every LC_BUILD_VERSION load command in the binary (one per slice on a fat
 * binary). Returns [] if the binary carries none — including the legacy
 * LC_VERSION_MIN_MACOSX case, which we deliberately do not handle: none of the
 * binaries we patch use it, and silently mis-parsing one would be worse than
 * failing loudly.
 */
function readBuildVersions(path: string, label: string): BuildVersion[] {
  let out: string;
  try {
    out = execFileSync("otool", ["-l", path], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  } catch (err) {
    fatal(`otool -l failed on ${path}: ${err instanceof Error ? err.message : String(err)}`, label);
  }

  const lines = out.split("\n");
  const versions: BuildVersion[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*cmd\s+LC_BUILD_VERSION\s*$/.test(lines[i]!)) continue;
    let minos: string | null = null;
    let sdk: string | null = null;
    // Scan the body of this load command only — stop at the next one.
    for (let j = i + 1; j < lines.length && !/^\s*cmd\s+LC_/.test(lines[j]!); j++) {
      const m = /^\s*minos\s+(\S+)\s*$/.exec(lines[j]!);
      if (m) minos = m[1]!;
      const s = /^\s*sdk\s+(\S+)\s*$/.exec(lines[j]!);
      if (s) sdk = s[1]!;
    }
    if (minos && sdk) versions.push({ minos, sdk });
  }

  return versions;
}

function assertMachO(path: string, label: string): void {
  let desc: string;
  try {
    desc = execFileSync("file", ["-b", path], { encoding: "utf8" }).trim();
  } catch (err) {
    fatal(`file(1) failed on ${path}: ${err instanceof Error ? err.message : String(err)}`, label);
  }
  if (!desc.includes("Mach-O")) {
    fatal(
      `${path} is not a Mach-O binary (file reports: ${desc}). ` +
        `Electrobun may have changed what it ships at this path — do not silently skip.`,
      label,
    );
  }
}

/** Fails the build if vtool isn't available. Call once, up front. */
export function assertVtoolAvailable(): void {
  try {
    execFileSync("/usr/bin/which", ["vtool"], { stdio: "ignore" });
  } catch {
    console.error(
      "[patch-minos] FATAL: `vtool` not found on PATH. It ships with the Xcode " +
        "command line tools — install them with `xcode-select --install`.",
    );
    process.exit(1);
  }
}

/**
 * Normalize `path`'s macOS deployment floor to TARGET_MINOS.
 *
 * Idempotent: reads the current minos first and skips vtool entirely if the
 * binary is already at or below the target. Verifies the result and fails the
 * build on any mismatch — a silently-unpatched binary is the exact bug this
 * guards against.
 *
 * Note on `-output <path> <path>`: same-path in/out was empirically verified
 * against a copy of the real shipped `launcher` (exit 0, minos updated, 0755
 * preserved, binary still executes).
 */
export function patchMinos(path: string, label: string): void {
  if (!existsSync(path)) {
    fatal(`expected binary not found at ${path}`, label);
  }
  assertMachO(path, label);

  const before = readBuildVersions(path, label);
  if (before.length === 0) {
    fatal(`no LC_BUILD_VERSION load command found in ${path} — cannot patch minos`, label);
  }

  if (before.every((v) => lte(v.minos, TARGET_MINOS))) {
    console.log(
      `[patch-minos] ${label}: minos ${before.map((v) => v.minos).join(", ")} already <= ${TARGET_MINOS} — skipping`,
    );
    return;
  }

  // Preserve the binary's existing SDK version rather than hardcoding one, so
  // this doesn't drift out of sync after a future Electrobun upgrade.
  const sdk = before[0]!.sdk;
  const modeBefore = statSync(path).mode;

  try {
    execFileSync(
      "vtool",
      ["-set-build-version", "macos", TARGET_MINOS, sdk, "-replace", "-output", path, path],
      { stdio: "pipe" },
    );
  } catch (err) {
    fatal(`vtool failed on ${path}: ${err instanceof Error ? err.message : String(err)}`, label);
  }

  const after = readBuildVersions(path, label);
  if (after.length === 0 || !after.every((v) => v.minos === TARGET_MINOS)) {
    fatal(
      `minos verification failed for ${path} — expected ${TARGET_MINOS}, ` +
        `got ${after.map((v) => v.minos).join(", ") || "(none)"}`,
      label,
    );
  }

  const modeAfter = statSync(path).mode;
  if (modeAfter !== modeBefore) {
    fatal(
      `vtool changed file mode on ${path}: ${modeBefore.toString(8)} → ${modeAfter.toString(8)}`,
      label,
    );
  }

  console.log(
    `[patch-minos] ${label}: minos ${before.map((v) => v.minos).join(", ")} → ${TARGET_MINOS} (sdk ${sdk} preserved)`,
  );
}
