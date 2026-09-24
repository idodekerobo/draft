import type { Metadata } from "next";
import GetStartedPage from "@/components/GetStartedPage";

export const metadata: Metadata = {
  title: "Get started with Draft",
  description:
    "Give every agent the context to do its best work with Draft, the company brain for AI-native teams.",
};

export default function GetStarted() {
  return <GetStartedPage />;
}
