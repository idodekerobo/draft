"use client";

import Link from "next/link";
import { useEffect } from "react";
import { ContextReader } from "draft-shared-ui";
import { useWorkspace } from "@/lib/workspace";

export default function ContextPage() {
  const { context, reloadContext, markContextSeen } = useWorkspace();
  useEffect(() => { markContextSeen(); }, [markContextSeen]);

  if (context.status === "loading") return <p className="ui-page ui-muted" role="status">Loading context…</p>;
  if (context.status === "error") {
    return (
      <div className="ui-page">
        <p className="ui-error" role="alert">
          Could not load your team&apos;s context. <button type="button" className="ui-link" onClick={() => void reloadContext()}>Try again</button>
        </p>
      </div>
    );
  }
  if (context.status === "empty") {
    return (
      <div className="ui-page">
        <h1 className="ui-page__title">Draft is still learning about your team</h1>
        <p className="ui-muted">Context appears here after Draft reads your team&apos;s sources. <Link href="/connections">Connect a tool</Link></p>
      </div>
    );
  }
  return <ContextReader entries={context.entries} snapshotCreatedAt={context.createdAt} />;
}
