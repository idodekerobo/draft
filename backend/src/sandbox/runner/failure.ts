import type { FailureCategory } from "draft-core/harnesses/types";
import type { RunnerFailureCode } from "draft-core/harnesses/types";

export interface FinalDiagnosticInput {
  timedOut: boolean;
  overflow: boolean;
  envelopeFound: boolean;
  envelopeIsError: boolean;
  payloadValid: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  failureCategory: FailureCategory;
}

export interface SafeFailureDiagnostics extends FinalDiagnosticInput {
  failureCode: RunnerFailureCode;
}

export function buildFailureDiagnostics(
  input: FinalDiagnosticInput,
): SafeFailureDiagnostics | null {
  if (input.payloadValid) return null;
  const failureCode: RunnerFailureCode = input.timedOut
    ? "timeout"
    : input.overflow
      ? "output_too_large"
      : input.envelopeIsError
        ? "claude_error"
        : input.exitCode !== 0 || input.signal !== null
          ? "claude_exit"
          : "incomplete_result";
  return { ...input, failureCode };
}
