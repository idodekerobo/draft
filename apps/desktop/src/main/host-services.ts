import { getCachedWorkspaceId } from "draft-core/auth-state";
import type { HostServices } from "draft-core/host/services";
import { capture } from "../exec";
import { getDesktopHostId } from "./host/machine-id";
import { realtime } from "./realtime/instance";
import { fetchServer, fetchServerJSON } from "./server/server-client";

/** The services the session host runs on, backed by this app's own modules. */
export const desktopHostServices: HostServices = {
  fetchServer,
  fetchServerJSON,
  realtime,
  capture,
  workspaceId: getCachedWorkspaceId,
  hostId: () => getDesktopHostId(),
};
