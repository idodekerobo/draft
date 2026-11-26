import type { ModelProviderView } from "draft-shared-ui";
import { apiFetch } from "@/lib/api";

type ModelProviderBody = { provider: string; can_edit: boolean; providers: ModelProviderView["providers"] };

export async function loadModelProvider(workspaceId: string): Promise<ModelProviderView> {
  const body = await apiFetch<ModelProviderBody>(`/workspaces/${workspaceId}/model-provider`);
  return { provider: body.provider, canEdit: body.can_edit, providers: body.providers };
}

export async function saveModelProvider(workspaceId: string, provider: string): Promise<void> {
  await apiFetch(`/workspaces/${workspaceId}/model-provider`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider }),
  });
}
