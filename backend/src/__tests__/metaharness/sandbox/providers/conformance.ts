import { describe, expect, it } from "bun:test";
import type { SandboxProvider, SandboxRef, SandboxSpec } from "../../../../metaharness/sandbox/providers";

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

    // A sleeping session keeps its volume, and a wake mounts a new machine on it.
    it("replaces the machine on a volume it kept", async () => {
      const provider = await makeProvider();
      const spec: SandboxSpec = { runId: `conformance-${crypto.randomUUID()}`, env: {}, metadata: { conformance: "true" }, volume: { sizeGb: 1 } };
      const first = await provider.create(spec);
      if (first.volume === null) throw new Error("The conformance sandbox has no volume");
      let replacement: SandboxRef | undefined;
      try {
        await provider.start(first);
        await provider.destroyMachine(first);
        expect(await provider.status(first)).toBe("missing");

        replacement = await provider.create({ ...spec, volume: { existing: first.volume } });
        expect(replacement.volume).toEqual(first.volume);
        await provider.start(replacement);
        expect(await provider.status(replacement)).toBe("running");
      } finally {
        await provider.destroy(replacement ?? first);
      }
    }, 300_000);
  });
}
