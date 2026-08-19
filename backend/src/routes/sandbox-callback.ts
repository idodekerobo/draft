import { SandboxCallbackRequestError } from "../sandbox/callback-request";
import { loadSandboxDeploymentConfig } from "../sandbox/config";
import { completeSynthesisRunCallback } from "../synthesis/orchestrate-run";
import {
  completeSummarizationRunCallback,
  SUMMARIZATION_RUN_ID_PREFIX,
} from "../summarization/complete-summarization-callback";
import { recordError } from "../errors/record-error";

// Routes by the x-draft-run-id header's prefix instead of a second HTTP
// route -- avoids adding another callback URL/secret to deployment config.
// Synthesis run IDs are bare UUIDs, so this prefix can never collide.
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

  const isSummarization = (request.headers.get("x-draft-run-id") ?? "").startsWith(
    SUMMARIZATION_RUN_ID_PREFIX,
  );

  try {
    return isSummarization
      ? await completeSummarizationRunCallback(request, callbackSecret)
      : await completeSynthesisRunCallback(request, callbackSecret);
  } catch (error) {
    if (error instanceof SandboxCallbackRequestError) {
      return new Response(null, { status: 401 });
    }
    // completeSynthesisRunCallback/completeSummarizationRunCallback own
    // stage-aware error recording.
    return new Response(null, { status: 500 });
  }
}
