import { harnessLabel } from "./harnesses";

export const SESSION_FAILURES = {
  launch_failed: { message: "The agent could not start this session. Try starting it again.", retryable: true },
  resume_check_failed: { message: "Could not prepare the agent. Check its installation and sign-in.", retryable: true },
  resume_folder_missing: { message: "The conversation or its folder is no longer on this computer. Restore the folder before resuming.", retryable: false },
  resume_failed: { message: "The agent could not resume this session. Try resuming again.", retryable: true },
  reopen_failed: { message: "Draft could not reopen this session. Check your connection and try again.", retryable: true },
  host_exited: { message: "The agent disconnected unexpectedly. Resume the session to continue.", retryable: true },
  host_reconnect_failed: { message: "The agent disconnected and could not reconnect. Resume the session to continue.", retryable: true },
  host_recovery_exhausted: { message: "The agent disconnected again after reconnecting. Resume the session to continue.", retryable: true },
  host_connection_lost: { message: "The agent connection was lost. Draft is trying to reconnect.", retryable: true },
  heartbeat_failed: { message: "Draft could not report that the session is online.", retryable: true },
  forwarding_failed: { message: "Draft could not sync the latest session activity.", retryable: true },
  upload_failed: { message: "Draft could not back up the session files. It will retry.", retryable: true },
} as const;

export type SessionFailureCode = keyof typeof SESSION_FAILURES;

export interface SessionFailure {
  id: string;
  requestId: string | null;
  code: SessionFailureCode;
  message: string;
  at: string;
  retryable: boolean;
}

export function sessionFailureMessage(code: SessionFailureCode, harness = "claude"): string {
  return SESSION_FAILURES[code].message.replace(/The agent|the agent/g, harnessLabel(harness));
}
