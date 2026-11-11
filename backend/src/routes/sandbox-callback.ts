import { SandboxCallbackRequestError } from "../sandbox/callback-request";
import { loadSandboxDeploymentConfig } from "../sandbox/config";
import { completeSynthesisRunCallback } from "../synthesis/orchestrate-run";
import { completeSummarizationRunCallback } from "../summarization/complete-summarization-callback";
import { completeRoutineRunCallback } from "../routines/complete-routine-callback";
import { recordError } from "../errors/record-error";
import { callbackKind } from "./callback-kind";

// One callback URL for every kind of run. The x-draft-run-id header is the agent run's id, and the run's
// kind picks the handler. The URL and the secret stay the same.
export async function POST(request: Request): Promise<Response> {
  let callbackSecret: string;
  try {
    callbackSecret = loadSandboxDeploymentConfig().callbackSecret;
  } catch (error) {
    void recordError({
      workspaceId: null,
      operation: "execution",
      message: "Sandbox callback configuration failed",
      code: "sandbox_callback_configuration_failed",
      error,
    });
    return new Response(null, { status: 500 });
  }

  const runIdHeader = request.headers.get("x-draft-run-id") ?? "";

  try {
    const { serviceClient } = await import("../db/client");
    const kind = await callbackKind(runIdHeader, serviceClient);
    if (kind === "routine") return await completeRoutineRunCallback(request, callbackSecret);
    if (kind === "summarization") return await completeSummarizationRunCallback(request, callbackSecret);
    return await completeSynthesisRunCallback(request, callbackSecret);
  } catch (error) {
    if (error instanceof SandboxCallbackRequestError) {
      return new Response(null, { status: 401 });
    }
    // completeSynthesisRunCallback/completeSummarizationRunCallback own
    // stage-aware error recording.
    return new Response(null, { status: 500 });
  }
}
