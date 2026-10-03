import "draft-shared-ui/styles/tokens.css";
import "draft-shared-ui/styles/shared-ui.css";
import "./globals.css";
import type { Metadata, Viewport } from "next";
import { THEME_BOOT_SCRIPT } from "draft-shared-ui/theme";
import { AnalyticsProvider } from "@/lib/analytics/AnalyticsProvider";

export const metadata: Metadata = {
  title: "Draft",
  description: "Shared context for teams building with AI.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta name="theme-color" content="#211f1d" />
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body>
        <AnalyticsProvider>{children}</AnalyticsProvider>
      </body>
    </html>
  );
}
