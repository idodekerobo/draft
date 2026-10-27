"use client";

import { ColumnToggleButton } from "draft-shared-ui";

export default function SessionsPage() {
  return (
    <div className="ui-session">
      <header className="ui-session__header">
        <nav className="ui-session__crumbs" aria-label="Breadcrumb">
          <ColumnToggleButton where="main" />
          <h1 className="ui-session__title">Sessions</h1>
        </nav>
      </header>
      <div className="ui-start__body">
        <p className="ui-start__heading">Pick a session</p>
        <p className="ui-muted">Choose one from the list to watch it and send a message. Start a new session in the Draft desktop app.</p>
      </div>
    </div>
  );
}
