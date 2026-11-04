import type { Metadata } from "next";
import SignupHero from "@/components/SignupHero";

export const metadata: Metadata = {
  title: "Get started with Draft",
  description: "Create your account and set up your team's shared context for you and your AI agents.",
};

export default function Join() {
  return <SignupHero variant="join" />;
}
