// ConnectionsView.tsx — permanent home for sources, the agent and local tools

import { DataBoundary } from "draft-shared-ui";
import { rpc } from "../../rpc";
import { useConnectedAppsSuspense } from "../../hooks/useConnectedApps";
import { DesktopToolList } from "../connections/DesktopToolList";

const CLI_DOCS_URL = "https://github.com/idodekerobo/draft/blob/main/docs/mcp.md#use-the-cli-instead";

function ConnectionsBody() {
  const { apps, refresh } = useConnectedAppsSuspense();
  return (
    <>
      <DesktopToolList apps={apps} refresh={refresh} allowManage />
      <p className="ui-page__footer">
        More ways to use Draft:{" "}
        <button type="button" className="ui-link" onClick={() => rpc.send.openUrl({ url: apps.webAppUrl })}>web app</button>,{" "}
        <button type="button" className="ui-link" onClick={() => rpc.send.openUrl({ url: CLI_DOCS_URL })}>CLI</button>
      </p>
    </>
  );
}

export function ConnectionsView() {
  return (
    <div className="ui-page connections">
      <h1 className="ui-page__title">Connections</h1>
      <p className="ui-page__intro">Bring your sources together. Give your agents the context.</p>
      <DataBoundary fallback={<p className="ui-muted" role="status">Loading connections…</p>} errorMessage="Could not load your connections.">
        <ConnectionsBody />
      </DataBoundary>
    </div>
  );
}
