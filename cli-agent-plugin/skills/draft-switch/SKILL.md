---
name: draft-switch
description: >
  Activate a named Draft profile and install that profile's team skills and MCP
  definitions through the canonical CLI lifecycle.
---

# /draft:switch — Profile Activation

With no profile argument, run:

```bash
draft switch --json
```

With a profile argument, run:

```bash
draft switch "<profile>" --json
```

Do not write `~/.draft/active-profile` or install/uninstall assets directly. The
CLI validates the target before mutation, removes only assets owned by the old
profile, activates the target, and installs its assets.

Interpret the JSON result:

- If `ok` is true, confirm the active profile.
- If `partial` is true, list `missing_secrets` and `conflicts`. The profile is
  still active and personal assets remain untouched.
- If validation or activation fails, surface the error; the old profile remains
  active.

Remind the user to restart active agent sessions after a successful switch.
