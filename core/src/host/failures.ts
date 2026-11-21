import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "fs";
import { join } from "path";
import { SESSION_FAILURES, sessionFailureMessage, type SessionFailure, type SessionFailureCode } from "../session-failure";
import { hostSessionsDir } from "./cursor-store";
import { hostServices } from "./services";

interface FailureReport {
  failure: SessionFailure;
  sessionId: string;
  workspaceId: string;
  hostId: string;
  harness: string;
  phase: string;
  terminal: boolean;
  expectedRequestId: string | null;
  diagnostics: Record<string, string | number>;
}

export class SessionFailureReporter {
  private readonly reports = new Map<string, FailureReport>();
  private flushing: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly directory: () => string = () => join(hostSessionsDir(), "failures")) {}

  private reportPath(id: string): string { return join(this.directory(), `${id}.json`); }

  dispose(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  report(input: {
    sessionId: string; workspaceId: string; hostId: string; harness?: string;
    requestId?: string | null; expectedRequestId?: string | null;
    code: SessionFailureCode; phase: string; terminal?: boolean; error?: unknown;
  }): SessionFailure {
    const failure: SessionFailure = { id: crypto.randomUUID(), requestId: input.requestId ?? null, code: input.code, at: new Date().toISOString(), ...SESSION_FAILURES[input.code], message: sessionFailureMessage(input.code, input.harness) };
    const diagnostics: FailureReport["diagnostics"] = {};
    if (input.error instanceof Error) {
      const name = input.error.name === "Error" ? input.error.constructor.name : input.error.name;
      diagnostics.errorName = /^[A-Za-z]{1,95}Error$|^Error$/.test(name) ? name : "Error";
      const message = input.error.message;
      diagnostics.reason = /timed out/i.test(message) ? "timeout" : /closed|not running/i.test(message) ? "connection_closed"
        : /tmux_launch_failed/.test(message) ? "tmux_launch_failed" : /folder|conversation is not on/.test(message) ? "missing_folder_or_transcript"
        : diagnostics.errorName === "RpcError" ? "rpc_rejected" : "unknown";
    }
    if (input.error && typeof input.error === "object") {
      for (const key of ["code", "exitCode", "status"] as const) {
        const value = (input.error as Record<string, unknown>)[key];
        if (typeof value === "number" && Number.isFinite(value)) diagnostics[key === "code" ? "transportCode" : key] = value;
      }
    }
    const report: FailureReport = { failure, sessionId: input.sessionId, workspaceId: input.workspaceId, hostId: input.hostId, harness: input.harness ?? "claude", phase: input.phase, terminal: input.terminal ?? false, expectedRequestId: input.expectedRequestId ?? null, diagnostics };
    this.reports.set(failure.id, report);
    try {
      mkdirSync(this.directory(), { recursive: true, mode: 0o700 });
      writeFileSync(`${this.reportPath(failure.id)}.tmp`, JSON.stringify(report), { mode: 0o600 });
      renameSync(`${this.reportPath(failure.id)}.tmp`, this.reportPath(failure.id));
    } catch { console.error("[session-failure] could not save diagnostic", failure.id, failure.code); }
    console.error("[session-failure]", failure.id, failure.code, input.sessionId);
    void this.flush();
    return failure;
  }

  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.deliver().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  private async deliver(): Promise<void> {
    try {
      for (const name of readdirSync(this.directory()).filter(name => /^[0-9a-f-]{36}\.json$/.test(name))) {
        if (this.reports.has(name.slice(0, -5))) continue;
        try { const report = JSON.parse(readFileSync(join(this.directory(), name), "utf8")) as FailureReport; this.reports.set(report.failure.id, report); }
        catch { console.error("[session-failure] unreadable saved diagnostic", name); }
      }
    } catch {}
    for (const [id, report] of this.reports) {
      if (hostServices().workspaceId() !== report.workspaceId) continue;
      try {
        const response = await hostServices().fetchServer(`workspaces/${report.workspaceId}/errors`, {
          method: "POST", body: JSON.stringify({
            id: report.failure.id, code: report.failure.code, message: report.failure.message,
            operation: "session", sessionId: report.sessionId, hostId: report.hostId,
            detail: { phase: report.phase, ...report.diagnostics },
            sessionFailure: { requestId: report.failure.requestId, at: report.failure.at,
              terminal: report.terminal, expectedRequestId: report.expectedRequestId },
          }), signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) continue;
        this.reports.delete(id);
        rmSync(this.reportPath(id), { force: true });
      } catch {}
    }
    if (this.reports.size && !this.retryTimer) {
      this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.flush(); }, 15000);
      this.retryTimer.unref();
    }
  }
}

const reporter = new SessionFailureReporter();
export const reportSessionFailure = reporter.report.bind(reporter);
export const flushSessionFailures = reporter.flush.bind(reporter);
