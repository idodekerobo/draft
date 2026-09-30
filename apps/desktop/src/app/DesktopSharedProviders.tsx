import { useMemo, type ReactNode } from "react";
import { IntegrationActionsProvider } from "draft-shared-ui/integrations";
import type { IntegrationActions } from "draft-shared-ui";
import { useAnalytics } from "./analytics/AnalyticsContext";
import { rpc } from "./rpc";

export function DesktopSharedProviders({ children }: { children: ReactNode }) {
  const { track } = useAnalytics();
  const integrationActions = useMemo<IntegrationActions>(() => ({
    track,
    openUrl: (url) => rpc.send.openUrl({ url }),
    getSlackManifestUrl: () => rpc.request.getSlackManifestUrl(),
    listSlackChannels: (input) => rpc.request.listSlackChannels(input),
    connectSlack: (input) => rpc.request.connectSlack(input),
    updateSlackChannels: (input) => rpc.request.updateSlackChannels(input),
    connectFireflies: (input) => rpc.request.connectFireflies(input),
    connectGranola: (input) => rpc.request.connectGranola(input),
    connectLinear: (input) => rpc.request.connectLinear(input),
    connectSessionTracking: () => rpc.request.connectSessionTracking(),
    selectSessionRepoFolder: async () => {
      const result = await rpc.request.selectSessionRepoFolder();
      return { folderPath: result.folderPath ?? undefined };
    },
    enableSessionCaptureForRepo: (input) => rpc.request.enableSessionCaptureForRepo(input),
  }), [track]);

  return (
    <IntegrationActionsProvider actions={integrationActions}>
      {children}
    </IntegrationActionsProvider>
  );
}
