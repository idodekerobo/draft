// desktop/src/app/index.tsx — React entry point for the renderer process
//
// Initializes the RPC singleton (must happen before any bun request is made)
// then mounts the React root into #root.

import { rpc } from "./rpc"; // also registers all webview message handlers
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

// The webview ignores target="_blank", so web links open in the system browser instead.
document.addEventListener("click", (event) => {
  if (event.defaultPrevented || event.button !== 0) return;
  const link = (event.target as Element | null)?.closest?.("a[href]");
  if (!link) return;
  const href = (link as HTMLAnchorElement).href;
  if (!/^(https?:|mailto:)/i.test(href)) return;
  event.preventDefault();
  rpc.send.openUrl({ url: href });
});

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
