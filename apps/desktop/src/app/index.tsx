// desktop/src/app/index.tsx — React entry point for the renderer process
//
// Initializes the RPC singleton (must happen before any bun request is made)
// then mounts the React root into #root.

import "./rpc"; // side-effect: registers all webview message handlers
import { createRoot } from "react-dom/client";
import { THEME_STORAGE_KEY, applyTheme, isThemePreference } from "draft-shared-ui/theme";
import { App } from "./App";
import { AnalyticsProvider } from "./analytics/AnalyticsContext";
import { UserIdentityProvider } from "./identity/UserIdentityContext";
import { DesktopSharedProviders } from "./DesktopSharedProviders";
import { DesktopQueryProvider } from "./DesktopQueryProvider";

try {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  if (isThemePreference(stored)) applyTheme(stored);
} catch {}

const container = document.getElementById("root");
if (!container) throw new Error("[draft-desktop] #root element not found in index.html");

createRoot(container).render(
  <UserIdentityProvider>
    <AnalyticsProvider>
      <DesktopQueryProvider>
        <DesktopSharedProviders>
          <App />
        </DesktopSharedProviders>
      </DesktopQueryProvider>
    </AnalyticsProvider>
  </UserIdentityProvider>
);
