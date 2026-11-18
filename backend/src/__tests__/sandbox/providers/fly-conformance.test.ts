import { describe } from "bun:test";
import { loadFlyConfig } from "../../../sandbox/providers/fly/config";
import { createFlyProvider } from "../../../sandbox/providers/fly/provider";
import { runProviderConformance } from "./conformance";

// Creates and destroys real machines and volumes in the Fly app named by FLY_* env. Runs only with DRAFT_FLY_CONFORMANCE=1.
describe.skipIf(process.env.DRAFT_FLY_CONFORMANCE !== "1")("Fly", () => {
  runProviderConformance("fly", () => createFlyProvider(loadFlyConfig(process.env)));
});
