"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "draft-shared-ui";
import { contextQueryOptions } from "@/lib/queries";
import { apiFetch } from "@/lib/api";
import { useWorkspace } from "@/lib/workspace";

/** Land on Context when documents exist, otherwise Connections. */
export default function LandByState() {
  const router = useRouter();
  const { workspaceId } = useWorkspace();
  const { data, status } = useQuery(contextQueryOptions(workspaceId, apiFetch));
  useEffect(() => {
    if (status === "error") router.replace("/context");
    if (status === "success") router.replace(data === null ? "/connections" : "/context");
  }, [data, status, router]);
  return <p className="ui-page ui-muted" role="status">Loading your workspace…</p>;
}
