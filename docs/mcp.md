# MCP and agent connections

Draft exposes the company brain to MCP-compatible agents through a remote, OAuth-protected HTTP server. The hosted endpoint is:

~~~text
https://api.draftai.us/mcp
~~~

The MCP server is read-only. It resolves the caller's team-default workspace from the authenticated account, checks workspace access, and currently exposes:

| Tool | Purpose |
| --- | --- |
| `context.list` | List the workspace's available context dimensions. |
| `context.read` | Read one or more dimensions, or all current workspace documents. |
| `skills.list` | List shared workspace skills. |
| `skills.read` | Read one shared skill by name. |

## Connect Claude Code

Register Draft as a remote HTTP MCP server:

~~~bash
claude mcp add --transport http draft https://api.draftai.us/mcp
~~~

Start or restart a Claude Code session. When Claude Code connects for the first time, follow Draft's browser sign-in and consent flow. You can check the connection with `claude mcp list`.

## Connect Codex

Add Draft to the Codex MCP configuration at `~/.codex/config.toml`:

~~~toml
[mcp_servers.draft]
url = "https://api.draftai.us/mcp"
~~~

Start or restart Codex and complete the browser sign-in and consent flow when prompted by the MCP client.

## Use the CLI instead

The CLI reaches the same company brain through authenticated API calls. It is useful for scripts, setup, project instructions, and explicit reads:

~~~bash
curl -fsSL https://raw.githubusercontent.com/idodekerobo/draft/main/scripts/install-cli.sh | bash
draft auth login
draft context read --all
draft skills list
~~~

To make Draft discoverable from a project instruction file:

~~~bash
draft add claude-code --dir /path/to/project
draft add codex --dir /path/to/project
~~~

`draft add` writes a small managed block to `CLAUDE.md` or `AGENTS.md`; it does not copy the company brain into the repository. Use `draft sessions enable claude-code --dir ...` separately when the project should capture completed Claude Code sessions.

## Self-hosted deployments

Use the same `/mcp` path on the API base URL for a self-hosted deployment:

~~~text
https://api.example.com/mcp
~~~

The deployment must have its Better Auth MCP/OAuth configuration enabled, and the agent, CLI, web app, and desktop app should all point to the same Draft deployment. Configure the CLI with `DRAFT_API_BASE_URL`, `DRAFT_APP_URL`, `DRAFT_SUPABASE_URL`, and `DRAFT_SUPABASE_PUBLISHABLE_KEY` as described in the [CLI reference](./cli.md#configuration).
