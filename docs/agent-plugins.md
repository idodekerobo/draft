# Agent connections

Draft's company brain is useful when the agents doing the work can reach it. Today, the supported connection surface is a combination of the Draft CLI, project-local session hooks, and tool-specific integrations.

This surface is evolving. The current CLI/plugin implementation is an integration mechanism, not a promise that this is the final agent protocol.

## Current tools

The CLI and current integration code recognize:

- Claude Code
- Codex
- Cursor
- OpenClaw
- Hermes

Session capture currently has an installation path for Claude Code. Other agent names may be accepted by shared configuration while their capture path remains incomplete.

## What the connection does

A local connection can:

1. Resolve the active Draft API and Supabase configuration.
2. Authenticate the user or use a workspace-scoped session-ingest token.
3. Read the current workspace context for an agent.
4. Install a project-local session hook.
5. Read a completed coding-agent transcript and upload it to the Draft API.

The hook runs on the project machine. The backend stores and processes the uploaded session. The local hook is designed to return success to the agent even if the upstream upload fails, so it does not block the coding session.

## CLI setup

Install the released CLI:

~~~bash
curl -fsSL https://raw.githubusercontent.com/idodekerobo/draft/main/scripts/install-cli.sh | bash
~~~

Sign in:

~~~bash
draft auth login
draft auth whoami
~~~

Enable current Claude Code session capture for a project:

~~~bash
draft sessions enable claude-code --dir /path/to/project
~~~

This writes project-local configuration under .claude/draft/ and adds a SessionEnd hook to .claude/settings.json. Review and commit those project changes yourself. Draft does not commit them.

Read the current workspace or captured sessions:

~~~bash
draft context read --all
draft sessions list
draft sessions search "pattern"
~~~

For current project instructions, use draft add. It writes a managed Draft context block to the agent's project instruction file:

~~~bash
draft add claude-code --dir /path/to/project
draft add codex --dir /path/to/project
~~~

Use draft --help and docs/cli.md for the exact command surface; the CLI is changing as the agent connection model develops.

## Plugin repository

The cli-agent-plugin directory contains integrations and setup assets for agent tools. It is maintained separately as a subtree and may change substantially while the project evaluates a more direct agent connection model.

Do not describe the plugin as the team collaboration or storage layer. It connects local agents to the Draft workspace; the backend and workspace remain the source of truth.
