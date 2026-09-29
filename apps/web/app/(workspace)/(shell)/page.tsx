"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useWorkspace } from "@/lib/workspace";

/** Land on Context when documents exist, otherwise Connections. */
export default function LandByState() {
  const router = useRouter();
  const { context } = useWorkspace();
  useEffect(() => {
    if (context.status === "ready" || context.status === "error") router.replace("/context");
    if (context.status === "empty") router.replace("/connections");
  }, [context.status, router]);
  return <p className="ui-page ui-muted" role="status">Loading your workspace…</p>;
}
