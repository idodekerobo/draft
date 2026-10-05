"use client";

import { useState } from "react";
import { CopyableCmd } from "../onboarding/components";
import { SettingsRow } from "../settings/SettingsRow";

type ExportState = "idle" | "loading" | "done" | "error";

interface ContextExportProps {
  /** Runs the export. Throw to show an error, return false if the user canceled, otherwise return after the file is saved. */
  onExport: () => Promise<void | false>;
}

const AGENT_COMMANDS = ["cd draft-context && claude", "cd draft-context && codex"];

/** Renders list items; place inside a `ui-rows` list. */
export function ContextExport({ onExport }: ContextExportProps) {
  const [state, setState] = useState<ExportState>("idle");

  async function run() {
    setState("loading");
    try {
      const result = await onExport();
      setState(result === false ? "idle" : "done");
    } catch {
      setState("error");
    }
  }

  return (
    <>
      <li>
        <SettingsRow
          label="Export context"
          helper="Download your full context as a zip of markdown files, to use with any agent. This is a copy. Anyone with the file can read it."
          control={
            <button type="button" className="ui-btn" disabled={state === "loading"} onClick={() => void run()}>
              {state === "loading" ? "Exporting…" : "Export"}
            </button>
          }
        />
        {state === "error" && (
          <p className="ui-error" role="alert">Could not export your context. Try again in a moment.</p>
        )}
      </li>
      {state === "done" && (
        <li>
          <section className="ui-context-export__panel" aria-label="Use this with any agent">
            <h3 className="ui-group-label">Use this with any agent</h3>
            <p className="ui-muted">Unzip the download, then open your agent in the folder:</p>
            <ul className="ui-context-export__cmds">
              {AGENT_COMMANDS.map((cmd) => <li key={cmd}><CopyableCmd cmd={cmd} /></li>)}
            </ul>
          </section>
        </li>
      )}
    </>
  );
}
