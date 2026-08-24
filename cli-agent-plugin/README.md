# Draft agent connection

This directory contains Draft's current integrations for connecting local agent tools to the Draft company brain.

The connection surface is evolving. Today, the CLI and tool-specific hooks are the practical way for an agent to read workspace context and upload completed coding sessions. The repository may replace or reshape this integration as the best long-term agent connection model becomes clearer.

## What Draft provides

Draft gives connected agents access to a shared workspace containing company context, product context, priorities, decisions, and source-derived updates. The workspace is stored in the configured Draft deployment. This directory does not store or synchronize the company brain itself.

The local connection can:

- Make workspace context available at agent startup.
- Install a project-local session-end hook.
- Read a completed transcript from the local project machine.
- Upload that transcript to the Draft API using a workspace-scoped ingest token.

## Supported tool targets

The current setup assets include:

- Claude Code
- Codex
- Cursor
- OpenClaw
- Hermes

The main CLI currently has a session-capture installation path for Claude Code. Other tool integrations may provide context setup without supporting every session-capture feature.

The hook scripts require a POSIX shell environment. Windows is not currently supported.

## Recommended current path

Install the released Draft CLI:

~~~bash
curl -fsSL https://raw.githubusercontent.com/idodekerobo/draft/main/scripts/install-cli.sh | bash
~~~

Sign in:

~~~bash
draft auth login
draft auth whoami
~~~

Add the current Draft context instructions to a project:

~~~bash
draft add claude-code --dir /path/to/project
draft add codex --dir /path/to/project
~~~

This updates the project's CLAUDE.md or AGENTS.md with a managed block that points the agent at the current Draft CLI commands. It does not install a global daemon or copy the company brain into the project.

Enable session capture for a Claude Code project:

~~~bash
draft sessions enable claude-code --dir /path/to/project
~~~

This writes:

- .claude/draft/config.json with the configured API, workspace, and ingest token.
- .claude/draft/capture-session.sh, which reads the hook input and invokes the CLI.
- A SessionEnd hook entry in .claude/settings.json.

Review the project diff and commit these files yourself if you want the connection shared with that repository. Draft never commits on your behalf.

## Data path

~~~text
Agent session on the project machine
              |
              v
Local SessionEnd hook and CLI
              |
              v
Configured Draft API
              |
              v
Workspace session record and synthesis pipeline
~~~

The hook is local and should not block the agent if the API is unavailable. The backend stores the session and schedules server-side processing when the upload succeeds.

## Hosted and self-hosted deployments

The CLI defaults to Draft's hosted API. To connect this integration to a self-hosted deployment, configure the CLI with that deployment's API, app, and Supabase public values:

~~~env
DRAFT_API_BASE_URL=https://api.example.com
DRAFT_APP_URL=https://app.example.com
DRAFT_SUPABASE_URL=https://your-project.supabase.co
DRAFT_SUPABASE_PUBLISHABLE_KEY=your-public-key
~~~

The desktop app and CLI must point at the same Draft deployment if they are being used for the same workspace.

## Development

This directory is maintained as a subtree that can be published to the separate Draft plugin repository. Make changes in the monorepo, then use the repository's Makefile workflow when publishing the subtree.

Do not build new product assumptions around the current plugin file layout. The stable contract is the authenticated Draft API and workspace access model; the local agent connection layer may change.
