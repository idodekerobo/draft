import { SandboxCallbackRequestError } from "../sandbox/callback-request";
import { loadSandboxDeploymentConfig } from "../sandbox/config";
import { completeSynthesisRunCallback } from "../synthesis/orchestrate-run";
import { recordError } from "../errors/record-error";

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

  try {
    return await completeSynthesisRunCallback(request, callbackSecret);
  } catch (error) {
    if (error instanceof SandboxCallbackRequestError) {
      return new Response(null, { status: 401 });
    }
    // completeSynthesisRunCallback owns stage-aware error recording.
    return new Response(null, { status: 500 });
  }
}
