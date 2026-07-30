// desktop/scripts/postbuild.ts — copy compiled draft binary into Contents/MacOS/
//
// Runs after Electrobun assembles the app bundle, before its codesign step.
// Electrobun auto-signs every Mach-O binary in Contents/MacOS/ with
// --options runtime --timestamp, which satisfies Apple notarization.

import { copyFileSync, chmodSync, existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { patchMinos, assertVtoolAvailable } from "./lib/patch-minos";

const buildDir = process.env.ELECTROBUN_BUILD_DIR;
const appName  = process.env.ELECTROBUN_APP_NAME;

if (!buildDir || !appName) {
  console.error("[postbuild] Missing ELECTROBUN_BUILD_DIR or ELECTROBUN_APP_NAME");
  process.exit(1);
}

// Source: compiled by prebuild.sh into desktop/assets/bin/draft
// import.meta.dir is desktop/scripts/, so ../assets/bin/draft resolves correctly
const src  = join(import.meta.dir, "..", "assets", "bin", "draft");
const dest = join(buildDir, appName + ".app", "Contents", "MacOS", "draft");

if (!existsSync(src)) {
  console.error(`[postbuild] draft binary not found at ${src} — did prebuild.sh run?`);
  process.exit(1);
}

mkdirSync(join(buildDir, appName + ".app", "Contents", "MacOS"), { recursive: true });
copyFileSync(src, dest);
chmodSync(dest, 0o755);
console.log(`[postbuild] Copied draft binary → ${dest}`);

// Daemon binary — compiled by prebuild.sh into assets/background/draft-background-bin
// Must be in Contents/MacOS/ for Electrobun's auto-codesign step (notarization requires
// all Mach-O binaries in the bundle to be signed; Resources/ binaries are not signed).
const daemonSrc  = join(import.meta.dir, "..", "assets", "background", "draft-background-bin");
const daemonDest = join(buildDir, appName + ".app", "Contents", "MacOS", "draft-background-bin");

if (existsSync(daemonSrc)) {
  copyFileSync(daemonSrc, daemonDest);
  chmodSync(daemonDest, 0o755);
  console.log(`[postbuild] Copied daemon binary → ${daemonDest}`);
} else {
  console.warn(`[postbuild] daemon binary not found at ${daemonSrc} — skipping (dev build?)`);
}

// Bun runtime — from Electrobun's own dist; codesigned by Electrobun's build step
// along with draft and draft-background-bin. Enables zero-install TypeScript
// integration scripts (slack-capture, and future granola/github TypeScript ports).
const bunArch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
if (!bunArch) {
  console.error(`[postbuild] FATAL: unsupported macOS architecture: ${process.arch}`);
  process.exit(1);
}
const bunDist = `dist-macos-${bunArch}`;
const bunSrc  = join(import.meta.dir, "..", "node_modules", "electrobun", bunDist, "bun");
const bunDest = join(buildDir, appName + ".app", "Contents", "MacOS", "bun");

if (!existsSync(bunSrc)) {
  console.error(`[postbuild] FATAL: bun runtime not found at ${bunSrc}`);
  console.error(`[postbuild] Check that electrobun's ${bunDist}/bun path exists for this architecture.`);
  process.exit(1);
}
copyFileSync(bunSrc, bunDest);
chmodSync(bunDest, 0o755);
console.log(`[postbuild] Copied bun runtime → ${bunDest}`);

// tmux binary — staged by prebuild.sh; codesigned by Electrobun's build step.
const tmuxSrc  = join(import.meta.dir, "..", "assets", "bin", "tmux");
const tmuxDest = join(buildDir, appName + ".app", "Contents", "MacOS", "tmux");

if (existsSync(tmuxSrc)) {
  copyFileSync(tmuxSrc, tmuxDest);
  chmodSync(tmuxDest, 0o755);
  console.log(`[postbuild] Copied tmux → ${tmuxDest}`);
} else {
  console.warn(`[postbuild] tmux binary not found at ${tmuxSrc} — session monitoring will be unavailable`);
}

// Remove the unsigned copy that Electrobun's copy config places in Resources/app/background/.
// Electrobun only signs binaries in MacOS/ — any Mach-O left in Resources/ will fail
// Apple notarization. install.sh is updated to source the binary from MacOS/ instead.
const resourcesDaemon = join(buildDir, appName + ".app", "Contents", "Resources", "app", "background", "draft-background-bin");
if (existsSync(resourcesDaemon)) {
  rmSync(resourcesDaemon);
  console.log(`[postbuild] Removed unsigned daemon copy from Resources (install.sh will source from MacOS/)`);
}

// ── Lower the macOS deployment floor on Electrobun's prebuilt inner binaries ──
//
// libasar.dylib and zig-zstd are downloaded prebuilt releases (zig-asar, zig-zstd)
// whose own release pipelines baked in a minos of 14.8.x — high enough that dyld
// refuses to load them on macOS 14.x, even though both link only libSystem.
// Runs before Electrobun's codesign step for this bundle, so signatures stay valid.
// See scripts/lib/patch-minos.ts for the full rationale.
assertVtoolAvailable();
const macosDir = join(buildDir, appName + ".app", "Contents", "MacOS");
patchMinos(join(macosDir, "libasar.dylib"), "libasar.dylib");
patchMinos(join(macosDir, "zig-zstd"),      "zig-zstd");
