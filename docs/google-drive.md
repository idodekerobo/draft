# Google Drive

Connect Google on the Connections page, then choose **Google Drive → Edit** to
add folders or shared drives. If Gmail is already connected, **Add Drive** opens
Google consent again. Allow Drive access, then choose folders in the browser.

**Every file in these folders goes into company context, including files only you
can see.** Draft supports native Google Docs, Sheets and Slides. PDFs, Office files
and shortcuts are not ingested. Shared company context means every workspace
member and their agents can read the captured files.

## Synced folders

The browser lists shared drives first, then My Drive folders. Open a folder to
browse its children, or use Add to sync it. A folder another person already syncs
shows **Already synced by <name>**. Nested synced folders are allowed. Only the
person who added a folder can remove it. The row shows the number of synced
folders and the last successful sync time.

You can also manage folders with the CLI:

```bash
draft connections connect google
draft connections drive folders add <google-folder-or-shared-drive-id>
draft connections drive folders list --json
draft connections drive status
draft connections drive folders remove <synced-folder-id>
```

The Google ID comes from its Drive URL. Remove uses the synced folder row ID
returned by list. Google consent can grant Gmail, Drive, or both; reconnect to add
a missing product. An administrator must enable the Drive, Docs, Sheets and Slides
APIs and add Drive read-only access to the Google consent screen before testing.

## Sync and limits

The first sync backfills native files modified in the last 90 days, up to 500
files per connection. Sync polls about every two minutes. Each poll processes up
to 100 files and 20 change pages, and refreshes comments on up to five recently
modified files (the last seven days). Rendered content is capped at 200,000
characters; Sheets reads up to 200 rows and 26 columns. Truncated output is labeled.
Comments include replies, quotes, resolution and deletion state. Their edits can
create a new captured version even when the file body is unchanged.

## Read and search

Agents use `drive.read` with `file_id`. Add `include: ["versions"]` to inspect
captured versions and their short change summaries. Use a `version` ID, or `as_of`
with an ISO timestamp, to read history; those two inputs cannot be combined.
Only captured versions exist. Changes between syncs can become one version.
`drive.search` searches the latest versions by default; `include_history: true`
can find text removed from a later version.

A latest read refreshes live when the owning connection's last successful sync is
older than five minutes. It uses only the asker's own Drive login. Without one,
it returns the stored copy labeled stale. Live refreshes are limited to 10 per
user per minute per backend process. Routine agents read latest shared files
through `sources.search` and `sources.read`; dedicated Drive history tools are a
follow-up. See [MCP tools](mcp.md) for inputs and paging.

## Removal and reconnect

Trash, removal, or leaving every synced folder causes sync to soft-delete every
captured version and clear the stored content. Files still inside another synced
folder stay available. Disconnect keeps captured files, stops ingestion and
releases the synced folders. Facts already in company context stay. Reconnecting
and adding folders resumes sync; duplicate files are deduplicated across the
workspace. Reconnect when the row says **Reconnect needed**.
