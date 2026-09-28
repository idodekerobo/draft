import { useMemo, type ReactNode } from "react";
import { IntegrationActionsProvider } from "draft-shared-ui/integrations";
import { HeadlessSetupActionsProvider } from "draft-shared-ui/onboarding";
import type { IntegrationActions, HeadlessSetupActions } from "draft-shared-ui";
import { useAnalytics } from "./analytics/AnalyticsContext";
import { events, rpc } from "./rpc";

export function DesktopSharedProviders({ children }: { children: ReactNode }) {
  const { track } = useAnalytics();
  const integrationActions = useMemo<IntegrationActions>(() => ({
    track: (event, properties) => track(event as never, properties as never),
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

  const headlessSetupActions = useMemo<HeadlessSetupActions>(() => ({
    getAvailableRunners: () => rpc.request.getAvailableRunners(),
    subscribeToProgress: (listener) => events.on("headlessProgress", listener),
    getContextFiles: async () => (await rpc.request.getContextFiles()).map((file) => ({ label: file.label })),
    selectSetupFolder: async () => {
      const result = await rpc.request.selectSetupFolder();
      return { folderPath: result.folderPath ?? undefined };
    },
    runHeadlessSetup: (input) => rpc.request.runHeadlessSetup(input),
    openWorkspaceInFinder: () => rpc.send.openWorkspaceInFinder({}),
  }), []);

  return (
    <IntegrationActionsProvider actions={integrationActions}>
      <HeadlessSetupActionsProvider actions={headlessSetupActions}>
        {children}
      </HeadlessSetupActionsProvider>
    </IntegrationActionsProvider>
  );
}
