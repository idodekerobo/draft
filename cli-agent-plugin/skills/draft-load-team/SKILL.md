---
name: draft-load-team
description: >
  Pull the latest team context, skills, and MCP definitions into the active
  Draft profile through the canonical CLI lifecycle.
---

# /draft:load-team — Load Team Context and Assets

Run the canonical lifecycle command:

```bash
draft load --json
```

Do not clone the repository, copy workspace files, install skills or MCPs, or
write profile state directly. The CLI owns validation, unpublished-change
protection, deletion propagation, installation, and rollback.

Interpret the JSON result:

- If `ok` is true, summarize loaded context and installed/removed team assets.
- If `partial` is true, list `missing_secrets` and `conflicts`. Missing MCP
  credentials and personal-name collisions are warnings, not load failures.
- If the result reports unpublished team changes, tell the user to run
  `draft publish` or explicitly rerun `draft load --discard-team-assets`.
- For validation or unexpected errors, surface the error and leave the active
  profile unchanged.

Never use `--discard-team-assets` without an explicit user request.
