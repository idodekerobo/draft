// commands/proposals.ts — interactive approve/reject pending AI proposals
//
// Reads proposals once at startup (no file-watching).
// Keypress (manual): [a]ccept [r]eject; (flagged): [a]cknowledge [d]ismiss.
// Data logic (Proposal type, listProposals, parseProposal, acceptProposal, rejectProposal)
// lives in draft-core/proposals so the desktop UI can reuse it.

import { getActiveProfile, getWorkspacePath } from "../utils/config";
import { green, red, dim, cyan, bold } from "../utils/output";
import {
  type Proposal,
  acknowledgeFlaggedProposal,
  listProposals,
  acceptProposal,
  applyProposalLocally,
  dismissFlaggedProposal,
  proposalArchiveDirs,
  rejectProposal,
} from "draft-core/proposals";

export async function runProposals(args: string[]): Promise<void> {
  if (args.includes("--help")) {
    console.log("Usage: draft proposals");
    console.log("Interactively review pending AI-generated context proposals.");
    console.log("Manual: [a]ccept  [r]eject. Flagged: [a]cknowledge  [d]ismiss.");
    console.log("All items: [s]kip  [q]uit");
    process.exit(0);
  }

  const profile = getActiveProfile();
  const workspace = getWorkspacePath(profile);
  const { accepted: acceptedDir, rejected: rejectedDir } = proposalArchiveDirs(workspace);

  // Scan once at startup (oldest first) — listProposals from draft-core/proposals
  const proposals = listProposals(workspace);

  if (proposals.length === 0) {
    console.log(dim("No pending proposals."));
    process.exit(0);
  }

  console.log("");
  console.log(`${bold(String(proposals.length))} pending proposal(s).`);
  console.log("");

  for (let i = 0; i < proposals.length; i++) {
    const proposal = proposals[i];
    printProposalHeader(proposal, i + 1, proposals.length);

    const key = await readKey();

    if (key === "q") {
      console.log(dim("\nQuit."));
      process.exit(0);
    }

    if (proposal.kind === "flagged" && key === "a") {
      acknowledgeFlaggedProposal(proposal, workspace);
      console.log(`\n${green("[✓]")} Acknowledged. ${dim("No context files were changed.")}`);
    } else if (proposal.kind === "flagged" && key === "d") {
      dismissFlaggedProposal(proposal, workspace);
      console.log(`\n${red("[✗]")} Dismissed. ${dim("No context files were changed.")}`);
    } else if (proposal.kind === "manual" && key === "a") {
      applyProposalLocally(proposal, workspace);
      acceptProposal(proposal, acceptedDir);
      console.log(`\n${green("[✓]")} Accepted locally. ${dim("Run `draft publish` to publish context and team assets together.")}`);
    } else if (proposal.kind === "manual" && key === "r") {
      rejectProposal(proposal, rejectedDir);
      console.log(`\n${red("[✗]")} Rejected.`);
    } else {
      // skip
      console.log(`\n${dim("[~]")} Skipped.`);
    }
    console.log("");
  }

  console.log(dim("All proposals reviewed."));
}

// ── Rendering ──────────────────────────────────────────────────────────────────

function printProposalHeader(p: Proposal, index: number, total: number): void {
  const separator = "─".repeat(50);
  console.log(dim(separator));
  console.log(`${dim(`[${index}/${total}]`)}  ${bold("source:")} ${cyan(p.source)}${p.createdAt ? `  ${dim(p.createdAt)}` : ""}`);
  console.log(`${bold("summary:")} ${p.summary}`);
  if (p.kind === "flagged") {
    console.log(`${bold("needs input:")} ${red(p.needsInputReason || p.outcome || "Human review required")}`);
  }
  if (p.body) {
    console.log("");
    // Print first 20 lines of body as diff preview
    const lines = p.body.split("\n").slice(0, 20);
    for (const line of lines) {
      if (line.startsWith("+")) {
        console.log(green(line));
      } else if (line.startsWith("-")) {
        console.log(red(line));
      } else {
        console.log(dim(line));
      }
    }
    if (p.body.split("\n").length > 20) {
      console.log(dim("  ... (truncated)"));
    }
  }
  console.log("");
  const actions = p.kind === "flagged"
    ? `${cyan("[a]cknowledge")}  ${red("[d]ismiss")}`
    : `${cyan("[a]ccept")}  ${red("[r]eject")}`;
  process.stdout.write(`${actions}  ${dim("[s]kip")}  ${dim("[q]uit")}  › `);
}

// ── Single keypress reader ─────────────────────────────────────────────────────

function readKey(): Promise<string> {
  return new Promise((resolve) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    const handler = (key: string) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", handler);

      const k = key.toLowerCase();
      if (k === "a" || k === "r" || k === "d" || k === "s" || k === "q" || k === "\u0003" /* Ctrl+C */) {
        resolve(k === "\u0003" ? "q" : k);
      } else {
        // invalid key — re-prompt
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.once("data", handler);
      }
    };

    process.stdin.once("data", handler);
  });
}
