/** A folder in the .env checklist, holding files and folders below it. */
export interface EnvFolder {
  name: string;
  path: string;
  files: string[];
  folders: EnvFolder[];
}

/** Groups paths relative to the snapshot folder by their folders. Top-level files sit on the root. */
export function envTree(paths: string[]): EnvFolder {
  const root: EnvFolder = { name: "", path: "", files: [], folders: [] };
  for (const path of [...paths].sort()) {
    const parts = path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      const childPath = node.path ? `${node.path}/${part}` : part;
      let child = node.folders.find((folder) => folder.path === childPath);
      if (!child) {
        child = { name: part, path: childPath, files: [], folders: [] };
        node.folders.push(child);
      }
      node = child;
    }
    node.files.push(path);
  }
  return root;
}

/** Every file in a folder and the folders below it. */
export function filesUnder(folder: EnvFolder): string[] {
  return [...folder.files, ...folder.folders.flatMap(filesUnder)];
}

/** A folder is ticked when all its files are, mixed when some are. */
export function folderState(folder: EnvFolder, ticked: ReadonlySet<string>): "all" | "some" | "none" {
  const files = filesUnder(folder);
  const count = files.filter((file) => ticked.has(file)).length;
  return count === 0 ? "none" : count === files.length ? "all" : "some";
}
