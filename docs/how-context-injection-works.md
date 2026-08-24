# How agents reach the company brain

Draft has a server-side workspace and local agent connections. The exact delivery mechanism varies by tool and is still evolving, but the responsibilities are stable.

## At session start

The local connection reads the configured Draft deployment and makes the current workspace context available to the agent. Depending on the tool, this can use a project instruction file, a hook, the CLI, or a tool-specific integration.

The context comes from the authenticated workspace. It is not a private copy maintained in a team Git repository.

The current CLI setup path is:

~~~bash
draft auth login
draft add claude-code --dir /path/to/project
draft add codex --dir /path/to/project
~~~

`draft add` writes a managed Draft block to the project's `CLAUDE.md` or `AGENTS.md`. That block points the agent at the current CLI-based context connection. It is the current integration mechanism, not a promise that this file layout or plugin protocol is permanent.

## When a session ends

When coding-session capture is enabled, a project-local SessionEnd hook:

1. Receives the agent's session-end event.
2. Resolves the project's Draft configuration.
3. Reads the completed transcript from the local machine.
4. Sends it to the Draft API using the project's session-ingest token.
5. Returns without blocking the agent if the upload fails.

The backend stores the session, schedules any summarization or synthesis work, and exposes the resulting status through the API.

## What the agent receives

The company brain is made up of workspace context such as:

- Company and product context.
- Team and role context.
- Priorities and decisions.
- Context versions created from connected sources.
- Other custom workspace dimensions.

An agent can also use the CLI's context and session commands directly when it needs more detail than the connection's initial context.

## Local versus server-side

Local:

- Agent configuration and project hook files.
- Auth/session state and workspace identifiers.
- The source transcript before upload.
- Temporary runtime files and logs.

Server-side:

- The authenticated workspace and access control.
- Versioned context and source items.
- Uploaded session data and synthesis runs.
- Integration credentials and provider connection state.

## Troubleshooting

Check that the CLI is signed in:

~~~bash
draft auth whoami
~~~

Check that the project hook is installed:

~~~bash
draft sessions status --dir /path/to/project
~~~

If the project points at a self-hosted deployment, verify DRAFT_API_BASE_URL and the matching Supabase public configuration. A local hook can still exit successfully when the API is unavailable; inspect the local project/runtime logs and the backend logs for the failed upload.
