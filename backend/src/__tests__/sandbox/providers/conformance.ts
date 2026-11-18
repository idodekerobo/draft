import { describe, expect, it } from "bun:test";
import type { SandboxProvider, SandboxRef, SandboxSpec } from "../../../sandbox/providers";

/**
 * Runs the lifecycle every provider must support: create with a volume, start, stop, start again, destroy.
 * A failed step still destroys what was created.
 */
export function runProviderConformance(
  name: string,
  makeProvider: () => SandboxProvider | Promise<SandboxProvider>,
): void {
  describe(`${name} provider conformance`, () => {
    // A real provider boots machines, so one lifecycle takes much longer than Bun's 5 second default.
    it("runs the sandbox lifecycle with a volume", async () => {
      const provider = await makeProvider();
      const spec: SandboxSpec = {
        runId: `conformance-${crypto.randomUUID()}`,
        env: {},
        metadata: { conformance: "true" },
        volume: { sizeGb: 1 },
      };
      let ref: SandboxRef | undefined;
      let destroyed = false;
      try {
        ref = await provider.create(spec);
        expect(ref.volume).not.toBeNull();
        expect(await provider.status(ref)).toBe("stopped");

        await provider.start(ref);
        expect(await provider.status(ref)).toBe("running");

        await provider.stop(ref);
        expect(await provider.status(ref)).toBe("stopped");

        await provider.start(ref);
        expect(await provider.status(ref)).toBe("running");

        await provider.destroy(ref);
        destroyed = true;
        expect(await provider.status(ref)).toBe("missing");
      } finally {
        if (ref !== undefined && !destroyed) await provider.destroy(ref);
      }
    }, 300_000);
  });
}
