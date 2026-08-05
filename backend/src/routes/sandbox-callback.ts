import { SandboxCallbackRequestError } from "../sandbox/callback-request";
import { loadSandboxDeploymentConfig } from "../sandbox/config";
import { completeSynthesisRunCallback } from "../synthesis/orchestrate-run";

export async function POST(request: Request): Promise<Response> {
  try {
    const { callbackSecret } = loadSandboxDeploymentConfig();
    return await completeSynthesisRunCallback(request, callbackSecret);
  } catch (error) {
    if (error instanceof SandboxCallbackRequestError) {
      return new Response(null, { status: 401 });
    }
    console.error("sandbox-callback POST failed", error);
    return new Response(null, { status: 500 });
  }
}
