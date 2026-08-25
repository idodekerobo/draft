import type { Metadata } from "next";
import { Fraunces, Plus_Jakarta_Sans, JetBrains_Mono } from "next/font/google";
import { PostHogProvider } from "@/lib/PostHogProvider";
import CrispChat from "@/components/CrispChat";
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
  title: "Draft - The company brain for teams using AI agents",
  description:
    "Draft turns your company's decisions, priorities, and activity into shared context every connected AI agent can use.",
  openGraph: {
    title: "Draft - The company brain for teams using AI agents",
    description:
      "Draft turns your company's decisions, priorities, and activity into shared context every connected AI agent can use.",
    url: "https://draftai.us",
    siteName: "Draft",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Draft - The company brain for teams using AI agents",
    description:
      "Draft turns your company's decisions, priorities, and activity into shared context every connected AI agent can use.",
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
        <CrispChat />
      </body>
    </html>
  );
}
