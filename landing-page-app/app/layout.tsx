import type { Metadata } from "next";
import { Fraunces, Plus_Jakarta_Sans, JetBrains_Mono } from "next/font/google";
import { PostHogProvider } from "@/lib/PostHogProvider";
import "./globals.css";

const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-fraunces",
  axes: ["opsz"],
  display: "swap",
});

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
  title: "Draft — Context layer for your team's AI sessions",
  description:
    "Draft runs in the background, capturing context from your meetings, Slack, and GitHub — then injects it automatically at every agent session start. No re-explaining. No copy-pasting.",
  openGraph: {
    title: "Draft — Context layer for your team's AI sessions",
    description:
      "Draft runs in the background, capturing context from your meetings, Slack, and GitHub — then injects it automatically at every agent session start. No re-explaining. No copy-pasting.",
    url: "https://draftai.us",
    siteName: "Draft",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Draft — Context layer for your team's AI sessions",
    description:
      "Draft runs in the background, capturing context from your meetings, Slack, and GitHub — then injects it automatically at every agent session start.",
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
        className={`${fraunces.variable} ${jakarta.variable} ${jetbrains.variable} antialiased`}
      >
        <PostHogProvider>
          {children}
        </PostHogProvider>
      </body>
    </html>
  );
}
