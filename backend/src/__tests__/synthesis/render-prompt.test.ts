import { parseWorkspaceId } from "draft-core/run-spec";
import { createHash } from "node:crypto";
import { describe, expect, it } from "bun:test";
import {
  buildValidatedRunBundle,
  canonicalDocumentsHash,
  type BuildRunBundleInput,
  type ContextDocuments,
} from "../../synthesis/context-version-files";
import { renderSynthesisPrompt } from "../../synthesis/render-prompt";
import type { SynthesisFinalResult } from "../../synthesis/types";
import type { WorkspaceContextVersionRow } from "../../types/tables";

const ids = {
  organization: "11111111-1111-4111-8111-111111111111",
  team: "22222222-2222-4222-8222-222222222222",
  workspace: "33333333-3333-4333-8333-333333333333",
  version: "44444444-4444-4444-8444-444444444444",
  run: "55555555-5555-4555-8555-555555555555",
  source1: "66666666-6666-4666-8666-666666666666",
  source2: "77777777-7777-4777-8777-777777777777",
};

function hash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function document(content: string) {
  return { content, sha256: hash(content) };
}

function version(documents: ContextDocuments): WorkspaceContextVersionRow {
  return {
    id: ids.version,
    workspace_id: ids.workspace,
    version_number: 3,
    previous_version_id: null,
    documents_json: documents,
    content_hash: canonicalDocumentsHash(documents),
    creation_reason: "seed",
    synthesis_run_id: null,
    restored_from_version_id: null,
    agent_run_id: null,
    summary: "test",
    created_at: "2026-08-03T00:00:00.000Z",
  };
}

function bundleInput(): BuildRunBundleInput {
  const source1Content = "# Meeting\nDecision made.\n";
  const source2Content = "# Follow-up\nAnother decision.\n";
  return {
    audience: { type: "system", workspaceId: parseWorkspaceId(ids.workspace) },
    identity: {
      organizationId: ids.organization,
      teamId: ids.team,
      workspaceId: ids.workspace,
    },
    run: {
      id: ids.run,
      workspace_id: ids.workspace,
      base_context_version_id: ids.version,
      prompt_version: "m1-v1",
    },
    baseVersion: version({
      "product/index.md": document("# Product\n"),
      "company/index.md": document("# Company\n"),
      "team/index.md": document("# Team\n"),
    }),
    sources: [
      {
        item: {
          id: ids.source1,
          workspace_id: ids.workspace,
          external_version: "1",
          content_markdown: source1Content,
          content_hash: hash(source1Content),
        },
        membership: {
          workspace_id: ids.workspace,
          agent_run_id: ids.run,
          source_item_id: ids.source1,
          source_item_version: "1",
          content_hash: hash(source1Content),
          position: 0,
        },
      },
      {
        item: {
          id: ids.source2,
          workspace_id: ids.workspace,
          external_version: "1",
          content_markdown: source2Content,
          content_hash: hash(source2Content),
        },
        membership: {
          workspace_id: ids.workspace,
          agent_run_id: ids.run,
          source_item_id: ids.source2,
          source_item_version: "1",
          content_hash: hash(source2Content),
          position: 1,
        },
      },
    ],
    limits: { maxFileBytes: 1_000_000, maxTotalBytes: 5_000_000 },
  };
}

describe("renderSynthesisPrompt", () => {
  it("lists the bundle's context paths with their read paths", async () => {
    const bundle = buildValidatedRunBundle(bundleInput());
    const { prompt } = await renderSynthesisPrompt(bundle);

    for (const logicalPath of [
      "product/index.md",
      "company/index.md",
      "team/index.md",
    ]) {
      expect(prompt).toContain(`- ${logicalPath}`);
      expect(prompt).toContain(`read from: input/context/${logicalPath}`);
    }
  });

  it("never emits an absolute filesystem path, only bundle-relative read paths", async () => {
    const bundle = buildValidatedRunBundle(bundleInput());
    const { prompt } = await renderSynthesisPrompt(bundle);

    // No occurrence of a leading "/" path segment (e.g. /tmp/..., /var/...)
    // anywhere a "read from:" line appears -- this was a real prior bug per
    // spike3-round-trip.ts's file-level comment (2026-08-03 run returned an
    // absolute scratch-directory path as a documents key).
    const readFromLines = prompt
      .split("\n")
      .filter((line) => line.trim().startsWith("read from:"));
    expect(readFromLines.length).toBeGreaterThan(0);
    for (const line of readFromLines) {
      const path = line.trim().replace("read from:", "").trim();
      expect(path.startsWith("/")).toBe(false);
      expect(path.startsWith("input/")).toBe(true);
    }

    // Source files are listed with their bundle-relative read path too.
    expect(prompt).toContain(`input/sources/0000-${ids.source1}.md`);
    expect(prompt).toContain(`input/sources/0001-${ids.source2}.md`);
  });

  it("includes sha256 hashes for each context file", async () => {
    const bundle = buildValidatedRunBundle(bundleInput());
    const { prompt } = await renderSynthesisPrompt(bundle);
    const expectedHash = bundle.files["input/context/product/index.md"].sha256;
    expect(prompt).toContain(`sha256: ${expectedHash}`);
  });

  it("produces a JSON schema that a valid final result satisfies structurally", async () => {
    const bundle = buildValidatedRunBundle(bundleInput());
    const { jsonSchema } = await renderSynthesisPrompt(bundle);

    const examplePayload: SynthesisFinalResult = {
      outcome: "changed",
      summary: "Updated product direction based on the July call.",
      needs_input: [
        {
          question: "Is pricing seats or usage-based?",
          current_claim: "usage-based",
          new_claim: "seats",
          reason: "the call contradicts context without superseding it",
          evidence: [{ source_item_id: ids.source1, excerpt: "we moved to seats" }],
        },
      ],
    };

    const schema = jsonSchema as {
      required: string[];
      properties: { outcome: { enum: string[] } };
    };

    // Required top-level fields present.
    for (const key of schema.required) {
      expect(Object.hasOwn(examplePayload, key)).toBe(true);
    }
    // Outcome enum matches.
    expect(schema.properties.outcome.enum).toContain(examplePayload.outcome);
    // The documents travel through context.write, so the final result has no documents key.
    expect(Object.keys((jsonSchema as { properties: object }).properties)).toEqual(["outcome", "summary", "needs_input"]);
    // needs_input items have all required fields per the schema.
    const needsInputItemSchema = (
      jsonSchema as {
        properties: { needs_input: { items: { required: string[] } } };
      }
    ).properties.needs_input.items;
    for (const item of examplePayload.needs_input ?? []) {
      for (const key of needsInputItemSchema.required) {
        expect(Object.hasOwn(item, key)).toBe(true);
      }
    }
  });

  it("tells the agent to write with context.write, rebase on a conflict and report only a landed change", async () => {
    const bundle = buildValidatedRunBundle(bundleInput());
    const { prompt } = await renderSynthesisPrompt(bundle);
    expect(prompt).toContain("context.write");
    expect(prompt).toContain("`baseSha: null`");
    expect(prompt).toContain("currentSha");
    expect(prompt).toContain("`retryable` is false");
    expect(prompt).toContain('Use "changed" only if a `context.write` call succeeded');
    expect(prompt).not.toContain("output/result.json");
    expect(prompt).not.toContain('"documents"');
  });

  it("handles a bundle with no source files", async () => {
    const input = bundleInput();
    input.sources = [];
    const bundle = buildValidatedRunBundle(input);
    const { prompt } = await renderSynthesisPrompt(bundle);
    expect(prompt).toContain("(no new source material)");
  });

  it("includes the bootstrap guidance section on a first run with dimensions", async () => {
    const input = bundleInput();
    input.baseVersion = version({});
    const bundle = buildValidatedRunBundle(input);
    const dimensions = [
      { dimensionName: "product", dimensionDescription: "problem it solves, target user" },
      { dimensionName: "brand", dimensionDescription: "User-defined dimension: brand" },
    ];
    const { prompt } = await renderSynthesisPrompt(bundle, dimensions);

    expect(prompt).toContain("Bootstrap guidance");
    expect(prompt).toContain("- product: problem it solves, target user");
    expect(prompt).toContain("- brand: User-defined dimension: brand");
  });

  it("omits the bootstrap section when the workspace already has context, even with dimensions passed", async () => {
    const bundle = buildValidatedRunBundle(bundleInput());
    const dimensions = [{ dimensionName: "product", dimensionDescription: "..." }];
    const { prompt } = await renderSynthesisPrompt(bundle, dimensions);
    expect(prompt).not.toContain("Bootstrap guidance");
  });

  it("omits the bootstrap section on a first run when no dimensions are passed", async () => {
    const input = bundleInput();
    input.baseVersion = version({});
    const bundle = buildValidatedRunBundle(input);
    const { prompt } = await renderSynthesisPrompt(bundle);
    expect(prompt).not.toContain("Bootstrap guidance");
  });

  it("includes the memory guidance section once memory/ documents are provisioned", async () => {
    const input = bundleInput();
    input.baseVersion = version({
      "product/index.md": document("# Product\n"),
      "memory/index.md": document("# Memory\n"),
      "memory/days/2026-09-25.md": document("---\nperiod: day\nstart: 2026-09-25\nend: 2026-09-25\n---\n\n(no entries yet)\n"),
    });
    const bundle = buildValidatedRunBundle(input);
    const { prompt } = await renderSynthesisPrompt(bundle);

    expect(prompt).toContain("Memory dimension");
    expect(prompt).toContain("not per-person files");
  });

  it("omits the memory guidance section when no memory/ documents exist", async () => {
    const bundle = buildValidatedRunBundle(bundleInput());
    const { prompt } = await renderSynthesisPrompt(bundle);
    expect(prompt).not.toContain("Memory dimension");
  });
});
