import { addDriveFolder, fetchDriveFolders, removeDriveFolder, type FetchResult } from "../../cloud-client.ts";
import { syncedFoldersFromBody } from "draft-core/integrations/google-drive-folders";
import { createIntegrationOutput, redactIntegrationText } from "../safe-output.ts";

export interface DriveFoldersDeps {
  list(): Promise<FetchResult<Record<string, unknown>>>;
  add(id: string): Promise<FetchResult<Record<string, unknown>>>;
  remove(id: string): Promise<FetchResult<Record<string, unknown>>>;
  stdout(text: string): void;
}
const defaults: DriveFoldersDeps = { list: fetchDriveFolders, add: addDriveFolder, remove: removeDriveFolder, stdout: (text) => process.stdout.write(text) };

export async function runDriveFolders(args: string[], deps: DriveFoldersDeps = defaults): Promise<number> {
  const json = args.includes("--json");
  const output = createIntegrationOutput({ json, stdout: deps.stdout });
  const words = args.filter((arg) => arg !== "--json");
  if (args.filter((arg) => arg === "--json").length > 1 || words.some((arg) => arg.startsWith("-"))) return output.error("invalid_usage");
  const status = words.length === 1 && words[0] === "status";
  const list = words.length === 2 && words[0] === "folders" && words[1] === "list";
  const mutation = words.length === 3 && words[0] === "folders" && (words[1] === "add" || words[1] === "remove") && words[2]!.trim();
  if (!status && !list && !mutation) return output.error("invalid_usage");
  const result = status || list ? await deps.list() : words[1] === "add" ? await deps.add(words[2]!) : await deps.remove(words[2]!);
  if (!result.ok) return output.error(result.code);
  if (status || list) {
    const state = syncedFoldersFromBody(result.value);
    if (json) {
      const { status: connectionStatus, ...folders } = state;
      deps.stdout(redactIntegrationText(JSON.stringify({ schema_version: 1, status: "drive_folders", provider: "google_drive", connectionStatus, ...folders })) + "\n");
      return 0;
    }
    deps.stdout(`Google Drive: ${state.reauthRequired ? "Reconnect needed" : state.status ?? "Not connected"}\n`);
    deps.stdout(`Last synced: ${state.lastSuccessAt ?? "Not synced yet"}\n`);
    if (!state.folders.length) deps.stdout("No synced folders. Add one with draft connections drive folders add <id>.\n");
    for (const folder of state.folders) deps.stdout(`${folder.id}  ${redactIntegrationText(folder.name)}  (${folder.folderKind}, ${folder.googleFolderId})\n`);
    return 0;
  }
  deps.stdout(json
    ? redactIntegrationText(JSON.stringify({ schema_version: 1, status: words[1] === "add" ? "folder_added" : "folder_removed", provider: "google_drive", ...result.value })) + "\n"
    : words[1] === "add" ? "Folder added. Its first sync starts within a few minutes.\n" : "Folder removed.\n");
  return 0;
}
