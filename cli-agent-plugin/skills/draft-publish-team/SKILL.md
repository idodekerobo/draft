---
name: draft-publish-team
description: >
  Publish accepted context proposals, context updates, team skills, and team
  MCP definitions in one canonical repository transaction.
---

# /draft:publish-team — Publish Team Context and Assets

Run:

```bash
draft publish --json
```

Do not clone the repository, apply proposals, copy workspace files, stage Git
paths, or update publish timestamps directly. The CLI owns the transaction and
updates local baselines only after a successful push.

Interpret the JSON result:

- If `ok` is true, summarize the published context changes and team assets.
- If there is nothing to publish, report that without treating it as an error.
- If authentication, validation, commit, or push fails, surface the error. Do
  not delete accepted proposals or claim the workspace was published.

Secrets and machine-local configuration are never published.
