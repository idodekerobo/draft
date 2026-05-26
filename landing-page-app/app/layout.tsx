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
  title: "Draft — AI Product Manager for Builders",
  description:
    "Scale yourself, not your headcount. Draft is the AI product manager that helps solo PMs and founders write better specs, think through strategy, and orchestrate your dev workflow.",
  openGraph: {
    title: "Draft — AI Product Manager for Builders",
    description:
      "Scale yourself, not your headcount. Draft helps solo PMs and founders write better specs, think through strategy, and orchestrate your entire dev workflow.",
    url: "https://draftai.us",
    siteName: "Draft AI",
    images: [{ url: "/og-image.png", width: 1200, height: 630 }],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    images: ["/og-image.png"],
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
