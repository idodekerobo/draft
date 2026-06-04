// desktop/scripts/postbuild.ts — copy compiled draft binary into Contents/MacOS/
//
// Runs after Electrobun assembles the app bundle, before its codesign step.
// Electrobun auto-signs every Mach-O binary in Contents/MacOS/ with
// --options runtime --timestamp, which satisfies Apple notarization.

import { copyFileSync, chmodSync, existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

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

// Remove the unsigned copy that Electrobun's copy config places in Resources/app/background/.
// Electrobun only signs binaries in MacOS/ — any Mach-O left in Resources/ will fail
// Apple notarization. install.sh is updated to source the binary from MacOS/ instead.
const resourcesDaemon = join(buildDir, appName + ".app", "Contents", "Resources", "app", "background", "draft-background-bin");
if (existsSync(resourcesDaemon)) {
  rmSync(resourcesDaemon);
  console.log(`[postbuild] Removed unsigned daemon copy from Resources (install.sh will source from MacOS/)`);
}
