import type { Metadata } from "next";
import GetStartedPage from "@/components/GetStartedPage";
import { MULTIPLAYER_CODING_CONTENT } from "@/lib/getstarted-content";

export const metadata: Metadata = {
  title: MULTIPLAYER_CODING_CONTENT.title,
  description:
    "Work in the same Claude Code or Codex session as your teammates with Draft.",
};

export default function GetStartedMultiplayerCoding() {
  return <GetStartedPage content={MULTIPLAYER_CODING_CONTENT} />;
}
