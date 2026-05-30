/// <reference lib="dom" />
// desktop/src/mainview/index.ts — Draft renderer process
//
// Spike scope: proves typed RPC round-trip (getStatus) and renderer→bun
// notification path (sendNotification message).

import { Electroview } from "electrobun/view";
import type { AppRPCType, DaemonStatus } from "../rpc/schema";

// ── RPC setup ─────────────────────────────────────────────────────────────────

const rpc = Electroview.defineRPC<AppRPCType>({
  maxRequestTime: 30_000,
  handlers: {
    requests: {
      // Bun asks renderer to show a confirmation dialog (Phase 4).
      // Returns true by default until the modal is wired.
      confirmLoad: async () => true,
    },
    messages: {
      // Bun notifies renderer of new proposals (Phase 2).
      proposalAdded: ({ source, count }) => {
        console.log(`[draft-renderer] proposalAdded source=${source} count=${count}`);
      },
      // Bun notifies renderer the daemon stopped (Phase 1).
      daemonStopped: () => {
        setStatusDot("stopped");
        setStatusLabel("Daemon stopped");
      },
      // Bun notifies renderer of a completed capture (Phase 2).
      captureComplete: ({ source }) => {
        console.log(`[draft-renderer] captureComplete source=${source}`);
      },
      // Bun updates the proposal badge count (Phase 2).
      badgeUpdate: ({ count }) => {
        console.log(`[draft-renderer] badgeUpdate count=${count}`);
      },
    },
  },
});

// Electroview must be instantiated to activate the RPC channel.
new Electroview({ rpc });

// ── DOM helpers ────────────────────────────────────────────────────────────────

function setStatusDot(state: "running" | "stopped" | "degraded" | "loading"): void {
  const dot = document.getElementById("status-dot");
  if (!dot) return;
  dot.className = `status-dot ${state}`;
}

function setStatusLabel(text: string): void {
  const el = document.getElementById("status-label");
  if (el) el.textContent = text;
}

function renderStatus(status: DaemonStatus): void {
  setStatusDot(status.state);
  setStatusLabel(
    status.state === "running"
      ? `Daemon running · PID ${status.pid}`
      : status.state === "degraded"
        ? "Daemon degraded"
        : "Daemon stopped"
  );
  const pre = document.getElementById("status-json");
  if (pre) pre.textContent = JSON.stringify(status, null, 2);
}

// ── Status fetch ──────────────────────────────────────────────────────────────

async function fetchStatus(): Promise<void> {
  try {
    const status = await rpc.request.getStatus();
    renderStatus(status);
  } catch (err) {
    setStatusLabel("RPC error");
    const pre = document.getElementById("status-json");
    if (pre) pre.textContent = String(err);
    console.error("[draft-renderer] getStatus failed:", err);
  }
}

// ── Button wiring ─────────────────────────────────────────────────────────────

document.getElementById("btn-refresh-status")?.addEventListener("click", () => {
  setStatusLabel("Refreshing...");
  fetchStatus();
});

document.getElementById("btn-notify")?.addEventListener("click", () => {
  rpc.send.sendNotification({
    title: "Draft",
    subtitle: "Spike test",
    body: "Renderer → RPC → notification ✓",
  });
});

// ── Init ──────────────────────────────────────────────────────────────────────

fetchStatus();
