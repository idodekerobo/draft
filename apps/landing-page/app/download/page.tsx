import type { Metadata } from "next";
import SignupHero from "@/components/SignupHero";

export const metadata: Metadata = {
  title: "Download Draft",
  description: "Get the Draft desktop app. Create your account and set up your team's shared context first.",
};

export default function Download() {
  return <SignupHero variant="download" />;
}
