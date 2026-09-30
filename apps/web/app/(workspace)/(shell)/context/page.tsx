"use client";

import Link from "next/link";
import { useEffect, useMemo } from "react";
import { ContextReader, DataBoundary, useSuspenseQuery } from "draft-shared-ui";
import { documentsToEntries } from "draft-shared-ui/context-files";
import { apiFetch } from "@/lib/api";
import { contextQueryOptions } from "@/lib/queries";
import { useWorkspace } from "@/lib/workspace";

function ContextBody() {
  const { workspaceId, markContextSeen } = useWorkspace();
  const { data: snapshot } = useSuspenseQuery(contextQueryOptions(workspaceId, apiFetch));
  const entries = useMemo(() => (snapshot ? documentsToEntries(snapshot.documents) : []), [snapshot]);
  const versionNumber = snapshot?.versionNumber;
  useEffect(() => {
    if (versionNumber !== undefined) markContextSeen(versionNumber);
  }, [versionNumber, markContextSeen]);

  if (!snapshot) {
    return (
      <div className="ui-page">
        <h1 className="ui-page__title">Draft is still learning about your team</h1>
        <p className="ui-muted">Context appears here after Draft reads your team&apos;s sources. <Link href="/connections">Connect a tool</Link></p>
      </div>
    );
  }
  return <ContextReader entries={entries} snapshotCreatedAt={snapshot.createdAt} />;
}

export default function ContextPage() {
  return (
    <DataBoundary
      fallback={<p className="ui-page ui-muted" role="status">Loading context…</p>}
      errorFallback={(retry) => (
        <div className="ui-page">
          <p className="ui-error" role="alert">
            Could not load your team&apos;s context. <button type="button" className="ui-link" onClick={retry}>Try again</button>
          </p>
        </div>
      )}
    >
      <ContextBody />
    </DataBoundary>
  );
}
