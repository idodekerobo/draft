// desktop/scripts/postbuild.ts — copy compiled draft binary into Contents/MacOS/
//
// Runs after Electrobun assembles the app bundle, before its codesign step.
// Electrobun auto-signs every Mach-O binary in Contents/MacOS/ with
// --options runtime --timestamp, which satisfies Apple notarization.

import { copyFileSync, chmodSync, existsSync, mkdirSync } from "fs";
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
const dest = join(buildDir, appName, "Contents", "MacOS", "draft");

if (!existsSync(src)) {
  console.error(`[postbuild] draft binary not found at ${src} — did prebuild.sh run?`);
  process.exit(1);
}

mkdirSync(join(buildDir, appName, "Contents", "MacOS"), { recursive: true });
copyFileSync(src, dest);
chmodSync(dest, 0o755);
console.log(`[postbuild] Copied draft binary → ${dest}`);
