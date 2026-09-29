// ConnectionsView.tsx — permanent home for sources, the agent and local tools

import { rpc } from "../../rpc";
import { useConnectedApps } from "../../hooks/useConnectedApps";
import { DesktopToolList } from "../connections/DesktopToolList";

const CLI_DOCS_URL = "https://github.com/idodekerobo/draft/blob/main/docs/mcp.md#use-the-cli-instead";

export function ConnectionsView() {
  const { apps, failed, refresh } = useConnectedApps();

  return (
    <div className="ui-page">
      <h1 className="ui-page__title">Connections</h1>
      {failed && (
        <p className="ui-error" role="alert">
          Could not load your connections. <button type="button" className="ui-link" onClick={() => void refresh()}>Try again</button>
        </p>
      )}
      {!apps && !failed && <p className="ui-muted" role="status">Loading connections…</p>}
      {apps && <DesktopToolList apps={apps} refresh={refresh} allowManage />}
      <p className="ui-page__footer">
        More ways to use Draft:{" "}
        {apps && <><button type="button" className="ui-link" onClick={() => rpc.send.openUrl({ url: apps.webAppUrl })}>web app</button>, </>}
        <button type="button" className="ui-link" onClick={() => rpc.send.openUrl({ url: CLI_DOCS_URL })}>CLI</button>
      </p>
    </div>
  );
}
