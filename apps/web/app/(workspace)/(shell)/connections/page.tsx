"use client";

import { WebToolList } from "@/components/WebToolList";
import { DOWNLOAD_URL } from "@/lib/config";

const CLI_DOCS_URL = "https://github.com/idodekerobo/draft/blob/main/docs/mcp.md#use-the-cli-instead";

export default function ConnectionsPage() {
  return (
    <div className="ui-page">
      <h1 className="ui-page__title">Connections</h1>
      <WebToolList allowDisconnect />
      <p className="ui-page__footer">
        More ways to use Draft: <a href={DOWNLOAD_URL}>desktop app for Mac</a>, <a href={CLI_DOCS_URL} target="_blank" rel="noreferrer">CLI</a>
      </p>
    </div>
  );
}
