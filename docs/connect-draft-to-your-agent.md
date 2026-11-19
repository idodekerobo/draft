# Connect Draft to your agent

Draft holds your company brain in one place. Connect an agent once, and it reads the same current context as everyone else. You do not update each agent by hand.

This guide helps you pick a path, connect, understand what the agent can do, and disconnect.

## Which path to use

| | MCP | CLI |
| --- | --- | --- |
| Best for | An agent that queries the brain during a session | Scripts, project setup, explicit reads |
| Install | None. Add one server URL. | Install the `draft` binary |
| Sign-in | Browser sign-in and consent, handled by the agent | `draft auth login` |
| Read context | `context.list`, `context.read` | `draft context list`, `draft context read` |
| Browse/search sources | `sources.list`, `sources.search`, `sources.read` | `draft sources list`, `draft sources search`, `draft sources read` |
| Skills: read | `skills.list`, `skills.read` | `draft skills list`, `draft skills read` |
| Skills: add | `skills.add` (needs the `write` scope) | `draft skills add` |
| Export context as files | `context.export` | `draft context export` |
| List routines | Coming | Coming |
| Draft app sessions | `sessions.list`, `sessions.read` | `draft sessions list`, `draft sessions read` |
| Captured coding sessions | `sources.list` / `sources.search` / `sources.read` | `draft sources list --type coding_session`, `draft sources search`, `draft sources read` |
| Capture setup | CLI only | `draft sources capture enable claude-code --dir <repo>` |

Use MCP when the agent should look things up on its own. Use the CLI when you run commands yourself or write a script.

## Connect an agent

### Claude Code

~~~bash
claude mcp add --transport http draft https://api.draftai.us/mcp
~~~

Restart the session, then follow the browser sign-in. See [Connect Claude Code](./mcp.md#connect-claude-code).

### Codex

Add Draft to `~/.codex/config.toml`, restart Codex, and finish the browser sign-in. See [Connect Codex](./mcp.md#connect-codex).

### Other agents

Any MCP client that supports remote HTTP servers and OAuth can connect to `https://api.draftai.us/mcp`. Draft is tested with Claude Code and Codex. We do not yet list other agents as supported, because we have not tested each one.

### Self-hosted Draft

Use `<your API base URL>/mcp`. See [Self-hosted deployments](./mcp.md#self-hosted-deployments).

## Safety model

- **You sign in with your Draft account.** The agent never sees your password.
- **Access stays inside your workspace.** The server checks workspace access on every call.
- **Read and write are separate scopes.** The server allows `read` and `write`. An agent needs the `write` scope for tools that change Draft data or take an action, such as editing routines, managing skills or teammates, connecting an integration, or posting to Slack. Without the scope, the call fails with `insufficient_scope`. The consent screen shows which scopes the agent asks for. Read it before you approve.
- **Export links are short-lived.** A `context.export` link expires after 5 minutes and stops working if you lose workspace access. The export is a copy outside Draft's access control, so treat the files as private.
- **Tool calls are logged.** Draft records each person-originated CLI or MCP tool call in `agent_query_log`, including reads and writes: who, which surface and command, its arguments, and the response size. Draft-run calls are recorded separately in `agent_run_tool_calls`. Today these logs are for operators; you cannot view them in the app, and they do not record which agent made a call.

## Disconnect an agent today

There is no "Connected agents" screen in the app yet. To stop an agent, remove Draft from the agent itself:

- **Claude Code:** `claude mcp remove draft`
- **Codex:** delete the `[mcp_servers.draft]` block from `~/.codex/config.toml`.
- **Other agents:** remove the server in that agent's MCP settings.

This stops the agent from calling Draft. It does **not** cancel the token Draft already issued. The token stays valid until it expires. Draft cannot revoke a single agent yet.

## See also

- [MCP and agent connections](./mcp.md)
- [CLI reference](./cli.md)
- [Privacy](./privacy.md)
