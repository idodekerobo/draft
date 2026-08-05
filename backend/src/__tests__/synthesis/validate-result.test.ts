import { describe, expect, it } from "bun:test";
import { validateSynthesisResult } from "../../synthesis/validate-result";

const runId = "55555555-5555-4555-8555-555555555555";
const baseVersionId = "44444444-4444-4444-8444-444444444444";

interface FakeClientOptions {
  baseDocuments?: Record<string, { content: string; sha256: string }>;
  runNotFoundError?: Error;
}

/**
 * Minimal fake standing in for the chainable Supabase query builder shape
 * `.from().select().eq().single()` used by validate-result.ts, mirroring the
 * fake in prepare-run.test.ts.
 */
function createFakeClient(options: FakeClientOptions = {}) {
  const baseDocuments =
    options.baseDocuments ??
    ({
      "product/index.md": { content: "# Product\noriginal content", sha256: "x" },
      "company/index.md": { content: "# Company\noriginal content", sha256: "y" },
    } as Record<string, { content: string; sha256: string }>);

  function from(table: string) {
    if (table === "synthesis_runs") {
      return {
        select: () => ({
          eq: () => ({
            single: async () => {
              if (options.runNotFoundError) {
                return { data: null, error: options.runNotFoundError };
              }
              return {
                data: { id: runId, base_context_version_id: baseVersionId },
                error: null,
              };
            },
          }),
        }),
      };
    }

    if (table === "workspace_context_versions") {
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({
              data: { documents_json: baseDocuments },
              error: null,
            }),
          }),
        }),
      };
    }

    throw new Error(`unexpected table: ${table}`);
  }

  return { from } as unknown as import("@supabase/supabase-js").SupabaseClient;
}

describe("validateSynthesisResult", () => {
  // Check 1: output parses as the expected result shape.
  describe("check 1: result shape", () => {
    it("rejects a non-object result", async () => {
      const client = createFakeClient();
      await expect(validateSynthesisResult(runId, "not an object", client)).rejects.toThrow(
        /must be a JSON object/,
      );
    });

    it("rejects a missing/invalid summary", async () => {
      const client = createFakeClient();
      await expect(
        validateSynthesisResult(runId, { outcome: "no_change", summary: "" }, client),
      ).rejects.toThrow(/summary must be a nonempty string/);
    });

    it("accepts a well-formed no_change result", async () => {
      const client = createFakeClient();
      const result = await validateSynthesisResult(
        runId,
        { outcome: "no_change", summary: "nothing changed" },
        client,
      );
      expect(result.runId).toBe(runId);
      expect(result.payload.outcome).toBe("no_change");
    });
  });

  // Check 2: document paths must be in the allowlist derived from the base
  // version's real document keys (fetched from Postgres), not a hardcoded list.
  describe("check 2: document allowlist derived from base version", () => {
    it("rejects a path not present in the base version's documents_json", async () => {
      const client = createFakeClient();
      await expect(
        validateSynthesisResult(
          runId,
          {
            outcome: "changed",
            summary: "added a new file",
            documents: { "invented/path.md": "new content" },
          },
          client,
        ),
      ).rejects.toThrow(/not in allowlist/);
    });

    it("accepts a path present in the base version's documents_json", async () => {
      const client = createFakeClient();
      const result = await validateSynthesisResult(
        runId,
        {
          outcome: "changed",
          summary: "updated product doc",
          documents: { "product/index.md": "# Product\nchanged content" },
        },
        client,
      );
      expect(result.payload.documents["product/index.md"]).toBe(
        "# Product\nchanged content",
      );
    });

    it("derives the allowlist per-run instead of using a hardcoded list", async () => {
      const client = createFakeClient({
        baseDocuments: {
          "custom/dimension.md": { content: "original", sha256: "z" },
        },
      });
      const result = await validateSynthesisResult(
        runId,
        {
          outcome: "changed",
          summary: "updated a non-standard dimension",
          documents: { "custom/dimension.md": "updated" },
        },
        client,
      );
      expect(result.payload.documents["custom/dimension.md"]).toBe("updated");
    });
  });

  // Check 3: no "..", no absolute paths, no symlink-like segments.
  describe("check 3: safe document paths", () => {
    it("rejects a path containing '..'", async () => {
      const client = createFakeClient({
        baseDocuments: {
          "../escape.md": { content: "x", sha256: "x" },
        },
      });
      await expect(
        validateSynthesisResult(
          runId,
          { outcome: "changed", summary: "s", documents: { "../escape.md": "y" } },
          client,
        ),
      ).rejects.toThrow(/unsafe document path/);
    });

    it("rejects an absolute path", async () => {
      const client = createFakeClient({
        baseDocuments: {
          "/etc/passwd.md": { content: "x", sha256: "x" },
        },
      });
      await expect(
        validateSynthesisResult(
          runId,
          { outcome: "changed", summary: "s", documents: { "/etc/passwd.md": "y" } },
          client,
        ),
      ).rejects.toThrow(/unsafe document path/);
    });

    it("rejects a symlink-like/unsafe segment even if it were in the allowlist", async () => {
      const client = createFakeClient({
        baseDocuments: {
          "product/.hidden.md": { content: "x", sha256: "x" },
        },
      });
      await expect(
        validateSynthesisResult(
          runId,
          { outcome: "changed", summary: "s", documents: { "product/.hidden.md": "y" } },
          client,
        ),
      ).rejects.toThrow(/safe relative Markdown path/);
    });

    it("accepts a normal safe relative path", async () => {
      const client = createFakeClient();
      const result = await validateSynthesisResult(
        runId,
        {
          outcome: "changed",
          summary: "s",
          documents: { "product/index.md": "changed" },
        },
        client,
      );
      expect(result.payload.outcome).toBe("changed");
    });
  });

  // Check 4: valid UTF-8 and under the size cap.
  describe("check 4: UTF-8 validity and size cap", () => {
    it("rejects a document exceeding the size cap", async () => {
      const client = createFakeClient();
      const huge = "a".repeat(200_001);
      await expect(
        validateSynthesisResult(
          runId,
          { outcome: "changed", summary: "s", documents: { "product/index.md": huge } },
          client,
        ),
      ).rejects.toThrow(/exceeds size cap/);
    });

    it("accepts a document within the size cap with unicode content", async () => {
      const client = createFakeClient();
      const result = await validateSynthesisResult(
        runId,
        {
          outcome: "changed",
          summary: "s",
          documents: { "product/index.md": "unicode content: café ✅" },
        },
        client,
      );
      expect(result.payload.documents["product/index.md"]).toContain("café");
    });
  });

  // Check 5: outcome is an allowed value.
  describe("check 5: outcome enum", () => {
    it("rejects an invalid outcome value", async () => {
      const client = createFakeClient();
      await expect(
        validateSynthesisResult(runId, { outcome: "maybe", summary: "s" }, client),
      ).rejects.toThrow(/invalid outcome/);
    });

    it("accepts outcome=changed and outcome=no_change", async () => {
      const client = createFakeClient();
      await expect(
        validateSynthesisResult(
          runId,
          { outcome: "changed", summary: "s", documents: { "product/index.md": "new" } },
          client,
        ),
      ).resolves.toBeDefined();
      await expect(
        validateSynthesisResult(runId, { outcome: "no_change", summary: "s" }, client),
      ).resolves.toBeDefined();
    });
  });

  // Check 6: outcome=changed must actually differ from the base version's
  // documents_json, fetched fresh from Postgres — never trusted from the
  // callback payload. This is the check added after the real production
  // incident where a run claimed changes it never made.
  describe("check 6: claimed changes must actually differ from the base version", () => {
    it("rejects a changed outcome whose content is byte-identical to the base version", async () => {
      const client = createFakeClient({
        baseDocuments: {
          "product/index.md": { content: "# Product\nsame content", sha256: "x" },
        },
      });
      await expect(
        validateSynthesisResult(
          runId,
          {
            outcome: "changed",
            summary: "claims a change but isn't one",
            documents: { "product/index.md": "# Product\nsame content" },
          },
          client,
        ),
      ).rejects.toThrow(/no document content actually differs/);
    });

    it("accepts a changed outcome where at least one document genuinely differs", async () => {
      const client = createFakeClient({
        baseDocuments: {
          "product/index.md": { content: "# Product\noriginal", sha256: "x" },
          "company/index.md": { content: "# Company\noriginal", sha256: "y" },
        },
      });
      const result = await validateSynthesisResult(
        runId,
        {
          outcome: "changed",
          summary: "genuinely updated product doc",
          documents: {
            "product/index.md": "# Product\noriginal",
            "company/index.md": "# Company\nactually different now",
          },
        },
        client,
      );
      expect(result.payload.documents["company/index.md"]).toBe(
        "# Company\nactually different now",
      );
    });

    it("fetches the base version fresh from Postgres rather than trusting the payload", async () => {
      // Even though the caller doesn't supply any base-version data in the
      // payload itself, the fake client's workspace_context_versions row is
      // what determines the diff outcome -- proving the check is Postgres-
      // sourced, not derived from rawResult.
      const client = createFakeClient({
        baseDocuments: {
          "product/index.md": { content: "authoritative base content", sha256: "x" },
        },
      });
      await expect(
        validateSynthesisResult(
          runId,
          {
            outcome: "changed",
            summary: "s",
            documents: { "product/index.md": "authoritative base content" },
          },
          client,
        ),
      ).rejects.toThrow(/no document content actually differs/);
    });
  });

  describe("bundleHash", () => {
    it("returns runId and payload correctly, with bundleHash currently a TODO placeholder", async () => {
      const client = createFakeClient();
      const result = await validateSynthesisResult(
        runId,
        { outcome: "no_change", summary: "s" },
        client,
      );
      expect(result.runId).toBe(runId);
      // bundleHash cannot be derived from runId + Postgres alone with the
      // current frozen signature -- see the TODO in validate-result.ts.
      expect(result.bundleHash).toBe("");
    });
  });
});
