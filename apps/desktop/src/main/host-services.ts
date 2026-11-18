import { getCachedWorkspaceId } from "draft-core/auth-state";
import type { HostServices } from "draft-core/host/services";
import { capture } from "../exec";
import { getDesktopHostId } from "./host/machine-id";
import { openCommandInTerminal } from "./host/open-in-terminal";
import { realtime } from "./realtime/instance";
import { fetchServer, fetchServerJSON } from "./server/server-client";

/** The services the session host runs on, backed by this app's own modules. */
export const desktopHostServices: HostServices = {
  fetchServer,
  fetchServerJSON,
  realtime,
  capture,
  openInTerminal: openCommandInTerminal,
  workspaceId: getCachedWorkspaceId,
  hostId: () => getDesktopHostId(),
};
