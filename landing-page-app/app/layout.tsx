import type { Metadata } from "next";
import { Plus_Jakarta_Sans, JetBrains_Mono } from "next/font/google";
import { PostHogProvider } from "@/lib/PostHogProvider";
import CrispChat from "@/components/CrispChat";
import "./globals.css";

const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-jakarta",
  display: "swap",
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
  weight: ["400", "500"],
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://draftai.us"),
  title: "Draft — Shared context for AI-native teams",
  description:
    "Draft keeps your company's decisions, customer context, and priorities current across every AI session your team starts.",
  openGraph: {
    title: "Draft — Shared context for AI-native teams",
    description:
      "Draft keeps your company's decisions, customer context, and priorities current across every AI session your team starts.",
    url: "https://draftai.us",
    siteName: "Draft",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Draft — Shared context for AI-native teams",
    description:
      "Draft keeps your company's decisions, customer context, and priorities current across every AI session your team starts.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${jakarta.variable} ${jetbrains.variable} antialiased`}
      >
        <PostHogProvider>
          {children}
        </PostHogProvider>
        <CrispChat />
      </body>
    </html>
  );
}
