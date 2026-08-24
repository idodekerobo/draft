# Synthesis and proposals

Draft turns activity from connected tools into proposed changes to the company brain.

The current hosted architecture stores source items, schedules synthesis runs, and commits validated context versions in the workspace. The desktop app displays workspace context and synthesis activity. The CLI can inspect captured coding-agent sessions.

## The current flow

~~~text
Connected source or local agent session
              |
              v
        Draft API ingestion
              |
              v
       Workspace source item
              |
              v
     Scheduled synthesis run
              |
              v
     Disposable Fly Machine
              |
              v
   Validated context version
~~~

The backend keeps the current context version and the evidence used to produce it. A synthesis run can produce no change, a rewrite, or a request for input when the evidence is contradictory or insufficient.

## Needs input

The current synthesis contract represents unresolved questions as an optional `needs_input` array in the model result. Each item names:

- The question for the team.
- The current claim and the new competing claim.
- Why the evidence cannot safely reconcile them.
- Source-item IDs and excerpts supporting the competing claims.

`needs_input` is independent of the run outcome. A run may commit a context change and still raise a question, or make no context change while asking for clarification. The backend stores the array on the synthesis run as `needs_input_json`.

The database also has fields for recording a future resolution, but the current public API and desktop UI do not yet expose a complete question-resolution workflow. Treat these records as persisted synthesis questions until that workflow is implemented.

## Sources

Current source paths include:

- Slack connections and batches.
- Fireflies and meeting data.
- Linear webhooks.
- GitHub App events and repository import.
- Claude Code session capture from a local project hook.
- Local folder uploads during onboarding.

The source is normalized before synthesis. The model run receives a bounded bundle rather than unrestricted access to the user's machine.

## Local versus hosted behavior

The local desktop or CLI may read source material before upload. After ingestion, the workspace, source item, run status, context version, and resulting session/synthesis records live in the configured Draft deployment.

In hosted mode, that deployment is operated by Draft. In self-hosted mode, it is operated by the person or organization running the stack.

## Legacy terminology

Older Draft docs describe a local proposals inbox, a local daemon, and publishing context to a private GitHub repository. Those were part of the earlier local-first collaboration model. The current collaboration model uses hosted or self-hosted organizations, teams, workspaces, and invite links. GitHub remains an integration and import source.
