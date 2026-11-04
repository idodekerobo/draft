import type { Metadata } from "next";
import DownloadPage from "@/components/DownloadPage";

export const metadata: Metadata = {
  title: "Download Draft",
  description: "Get the Draft desktop app. Create your account and set up your team's shared context first.",
};

export default function Download() {
  return <DownloadPage />;
}
