// desktop/scripts/postwrap.ts — lower the outer wrapper launcher's macOS floor
//
// Electrobun produces two bundles per release. postbuild.ts handles the inner
// bundle (the one that gets zstd'd into the self-update payload); this handles
// the outer self-extracting wrapper — the DMG'd .app a new user actually
// double-clicks, and therefore the binary that gates first launch.
//
// Its Contents/MacOS/launcher is Electrobun's `extractor`, built natively on
// arm64 with no -Dtarget, so it inherits the release machine's own OS version
// as its minos (14.8.5 in the last stable build). That alone made the app
// unlaunchable on macOS 14.x. It links only libSystem.
//
// Electrobun fires postWrap after assembling the wrapper and *before* codesigning
// it, so patching here keeps the signature valid.

import { join } from "path";
import { patchMinos, assertVtoolAvailable } from "./lib/patch-minos";

const wrapperBundle = process.env.ELECTROBUN_WRAPPER_BUNDLE_PATH;

if (!wrapperBundle) {
  console.error("[postwrap] FATAL: ELECTROBUN_WRAPPER_BUNDLE_PATH not set — Electrobun did not pass the wrapper bundle path");
  process.exit(1);
}

assertVtoolAvailable();
patchMinos(join(wrapperBundle, "Contents", "MacOS", "launcher"), "wrapper launcher");
