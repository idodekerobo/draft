import type { HomeThreadApi } from "draft-shared-ui";
import { apiFetch } from "@/lib/api";

/** Draft's thread on Home, through the backend: the person's own Home session and the models they can pick. */
export function homeThreadApi(workspaceId: string): HomeThreadApi {
  return {
    async loadSession() {
      const body = await apiFetch<{ session: { id: string; model: string | null }; can_reply: boolean }>(`/workspaces/${workspaceId}/home/session`);
      return { id: body.session.id, model: body.session.model, canReply: body.can_reply };
    },
    async loadModels() {
      return (await apiFetch<{ models: Array<{ id: string; name: string }> }>(`/workspaces/${workspaceId}/home/models`)).models;
    },
  };
}
