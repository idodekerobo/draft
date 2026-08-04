import { createHash } from "node:crypto";
import { describe, expect, it } from "bun:test";
import {
  buildValidatedRunBundle,
  canonicalDocumentsHash,
  type BuildRunBundleInput,
  type ContextDocuments,
} from "../context-version-files";
import type { WorkspaceContextVersionRow } from "../types/tables";

const ids = {
  organization: "11111111-1111-4111-8111-111111111111",
  team: "22222222-2222-4222-8222-222222222222",
  workspace: "33333333-3333-4333-8333-333333333333",
  version: "44444444-4444-4444-8444-444444444444",
  run: "55555555-5555-4555-8555-555555555555",
  source: "66666666-6666-4666-8666-666666666666",
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
    summary: "test",
    created_at: "2026-08-03T00:00:00.000Z",
  };
}

function input(): BuildRunBundleInput {
  const sourceContent = "# Meeting\nDecision made.\n";
  return {
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
      "product/log/20260803_decision.md": document("# Log\n"),
      "architecture/index.md": document("# Architecture\n🙂\n"),
    }),
    sources: [
      {
        item: {
          id: ids.source,
          workspace_id: ids.workspace,
          external_version: "1",
          content_markdown: sourceContent,
          content_hash: hash(sourceContent),
        },
        membership: {
          workspace_id: ids.workspace,
          synthesis_run_id: ids.run,
          source_item_id: ids.source,
          source_item_version: "1",
          content_hash: hash(sourceContent),
          position: 0,
        },
      },
    ],
    limits: { maxFileBytes: 1_000_000, maxTotalBytes: 5_000_000 },
  };
}

describe("validated run bundle", () => {
  it("builds deterministic sandbox-ready context, source, and run metadata", () => {
    const first = buildValidatedRunBundle(input());
    const secondInput = input();
    secondInput.baseVersion.documents_json = Object.fromEntries(
      Object.entries(secondInput.baseVersion.documents_json).reverse().map(
        ([path, value]) => [
          path,
          Object.fromEntries([
            ["sha256", value.sha256],
            ["content", value.content],
          ]),
        ],
      ),
    ) as ContextDocuments;

    const second = buildValidatedRunBundle(secondInput);
    expect(second).toEqual(first);
    expect(Object.keys(first.files)).toEqual([
      "input/context/architecture/index.md",
      "input/context/product/log/20260803_decision.md",
      "input/run.json",
      `input/sources/0000-${ids.source}.md`,
    ]);
    expect(first.files["input/context/architecture/index.md"].bytes).toBe(
      Buffer.byteLength("# Architecture\n🙂\n", "utf8"),
    );
    expect(first.outputPath).toBe("output/result.json");
  });

  it("orders multiple source rows by immutable membership position", () => {
    const ordered = input();
    const secondId = "77777777-7777-4777-8777-777777777777";
    const secondContent = "# Follow-up\nA second decision.\n";
    ordered.sources.push({
      item: {
        ...ordered.sources[0].item,
        id: secondId,
        external_version: "2",
        content_markdown: secondContent,
        content_hash: hash(secondContent),
      },
      membership: {
        ...ordered.sources[0].membership,
        source_item_id: secondId,
        source_item_version: "2",
        content_hash: hash(secondContent),
        position: 1,
      },
    });
    const reversed = { ...ordered, sources: [...ordered.sources].reverse() };

    expect(buildValidatedRunBundle(reversed)).toEqual(
      buildValidatedRunBundle(ordered),
    );
  });

  it("rejects unsafe and non-Markdown logical paths", () => {
    for (const path of ["../outside.md", "/absolute.md", "bad\\path.md", "product/data.json"]) {
      const candidate = input();
      candidate.baseVersion = version({ [path]: document("unsafe") });
      expect(() => buildValidatedRunBundle(candidate)).toThrow(
        "safe relative Markdown path",
      );
    }
  });

  it("rejects forged document and whole-version hashes", () => {
    const forgedDocument = input();
    forgedDocument.baseVersion.documents_json["architecture/index.md"].sha256 =
      "0".repeat(64);
    forgedDocument.baseVersion.content_hash = canonicalDocumentsHash(
      forgedDocument.baseVersion.documents_json,
    );
    expect(() => buildValidatedRunBundle(forgedDocument)).toThrow(
      "document sha256 does not match content",
    );

    const forgedVersion = input();
    forgedVersion.baseVersion.content_hash = "0".repeat(64);
    expect(() => buildValidatedRunBundle(forgedVersion)).toThrow(
      "content_hash does not match",
    );
  });

  it("rejects mutable identity names and cross-workspace attachments", () => {
    const mutableIdentity = input();
    mutableIdentity.identity.organizationId = "big";
    expect(() => buildValidatedRunBundle(mutableIdentity)).toThrow(
      "organizationId must be a UUID",
    );

    const crossWorkspace = input();
    crossWorkspace.sources[0].item.workspace_id =
      "77777777-7777-4777-8777-777777777777";
    expect(() => buildValidatedRunBundle(crossWorkspace)).toThrow(
      "source item workspace does not match bundle",
    );
  });

  it("rejects run/version and membership mismatches", () => {
    const wrongVersion = input();
    wrongVersion.run.base_context_version_id =
      "77777777-7777-4777-8777-777777777777";
    expect(() => buildValidatedRunBundle(wrongVersion)).toThrow(
      "run base version does not match",
    );

    const wrongRun = input();
    wrongRun.sources[0].membership.synthesis_run_id =
      "77777777-7777-4777-8777-777777777777";
    expect(() => buildValidatedRunBundle(wrongRun)).toThrow(
      "source membership run does not match",
    );
  });

  it("rejects forged sources, duplicate positions, invalid UTF-8, and size overruns", () => {
    const forgedSource = input();
    forgedSource.sources[0].membership.content_hash = "0".repeat(64);
    expect(() => buildValidatedRunBundle(forgedSource)).toThrow(
      "source item hash does not match exact content",
    );

    const duplicate = input();
    duplicate.sources.push({
      item: { ...duplicate.sources[0].item, id: "77777777-7777-4777-8777-777777777777" },
      membership: {
        ...duplicate.sources[0].membership,
        source_item_id: "77777777-7777-4777-8777-777777777777",
      },
    });
    expect(() => buildValidatedRunBundle(duplicate)).toThrow(
      "positions must be unique and contiguous",
    );

    const invalidUtf8 = input();
    invalidUtf8.baseVersion = version({
      "company/index.md": document("\ud800"),
    });
    expect(() => buildValidatedRunBundle(invalidUtf8)).toThrow("valid UTF-8");

    const fileTooLarge = input();
    fileTooLarge.limits.maxFileBytes = 4;
    expect(() => buildValidatedRunBundle(fileTooLarge)).toThrow(
      "exceeds maxFileBytes",
    );

    const bundleTooLarge = input();
    bundleTooLarge.limits.maxTotalBytes = 10;
    expect(() => buildValidatedRunBundle(bundleTooLarge)).toThrow(
      "exceeds maxTotalBytes",
    );
  });
});
