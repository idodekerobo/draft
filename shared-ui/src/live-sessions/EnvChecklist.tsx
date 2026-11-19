import { useEffect, useRef } from "react";
import { envTree, filesUnder, folderState, type EnvFolder } from "./env-tree";

/** A checkbox that can show a mixed state, which HTML sets only from script. */
function TriCheckbox({ state, onChange, label }: { state: "all" | "some" | "none"; onChange: (ticked: boolean) => void; label: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === "some";
  }, [state]);
  return <input ref={ref} type="checkbox" aria-label={label} checked={state === "all"} onChange={(event) => onChange(event.target.checked)} />;
}

function FolderRow({ folder, ticked, onToggle }: { folder: EnvFolder; ticked: ReadonlySet<string>; onToggle: (files: string[], on: boolean) => void }) {
  const state = folderState(folder, ticked);
  return (
    <li>
      <details className="ui-env-tree__folder">
        <summary>
          <TriCheckbox state={state} label={`All .env files in ${folder.path}`} onChange={(on) => onToggle(filesUnder(folder), on)} />
          <code>{folder.name}/</code>
          <span className="ui-muted"> {filesUnder(folder).length}</span>
        </summary>
        <Level folder={folder} ticked={ticked} onToggle={onToggle} />
      </details>
    </li>
  );
}

function Level({ folder, ticked, onToggle }: { folder: EnvFolder; ticked: ReadonlySet<string>; onToggle: (files: string[], on: boolean) => void }) {
  return (
    <ul className="ui-env-tree">
      {folder.folders.map((child) => <FolderRow key={child.path} folder={child} ticked={ticked} onToggle={onToggle} />)}
      {folder.files.map((file) => (
        <li key={file}>
          <label className="ui-start__env-file">
            <input type="checkbox" checked={ticked.has(file)} onChange={(event) => onToggle([file], event.target.checked)} />
            <code>{file.split("/").at(-1)}</code>
          </label>
        </li>
      ))}
    </ul>
  );
}

/** The folder's .env files as a tree. Ticking a folder ticks every file below it; each folder opens to adjust. */
export function EnvChecklist({ files, ticked, onToggle }: { files: string[]; ticked: string[]; onToggle: (files: string[], on: boolean) => void }) {
  return <Level folder={envTree(files)} ticked={new Set(ticked)} onToggle={onToggle} />;
}
