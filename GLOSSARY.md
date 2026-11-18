# Glossary

One word, one meaning. If a name in code or the database disagrees with this file, the name is wrong.
When you add a concept, add it here first.

## Work and where it runs

- **Session**: a live conversation that people see and can join. Table `sessions`. A session has events, inputs
  and contributors. A local session runs on a person's computer; a cloud session runs in a Draft sandbox.
  Not: a captured session, a Claude native session ID (`native_session_id`), a CLI sign-in.
- **Captured session**: a coding session ingested from someone's own machine, with summary state. Table `captured_sessions`.
  Draft did not start it.
- **Run**: one agent process that Draft starts with one fixed spec (`AgentRunSpec`). Table `agent_runs`. A cloud session
  makes a new run each time it wakes. A routine session has exactly one run.
- **Routine**: a scheduled job a person sees and manages. One `scheduled_tasks` row. An agent routine starts runs;
  built-in routines (for example "Update company context") run Draft jobs.
- **Start reason**: why a run started: `schedule`, `event` or `manual`. Stored `agent_runs.trigger.type` values
  `cron` and `system` mean a schedule start and a system start; they are not rewritten.
- **Runtime**: where a session or run executes: `local` or `cloud`.
- **Host**: the process that drives a session's harness and relays its events. The desktop host runs on a person's
  computer; the sandbox host runs in a cloud machine. Column `sessions.host_id`.
- **Machine**: one computer or VM. A host runs on a machine. Fly VM IDs are `sandbox_machine_id`.
- **Sandbox**: an isolated cloud machine Draft starts through a `SandboxProvider`. It may have a volume.
- **Environment**: staging or production. Only that.

## Agents

- **Harness**: an agent program that does the work: Claude Code, Codex, later Pi or OpenCode. `HarnessId`.
  Adapters live in `core/src/harnesses/<id>/`.
- **Metaharness**: Draft's backend layer that starts, runs and governs any harness: runs, the tool gateway, context,
  sandbox launch. `backend/src/metaharness/`.
- **Driver**: a harness's adapter for one session (`HarnessDriver`). Used by the desktop host and the sandbox host.
  Drivers live in `core/src/host/drivers/`.
- **Runner**: the one-shot program inside a routine sandbox (`backend/src/sandbox/runner.ts`). Not a CLI binary.
- **Toolset**: the native tools, MCP servers, skills and instructions a cloud run gets (`AgentRunToolset`).
- **Agent client**: an AI tool installed on a person's computer that Draft can connect to (Claude Code, Codex, Cursor).

## Who and on whose authority

- **User**: a login account. Table `users`.
- **Person**: a contact record for a teammate. Table `people`. A person may or may not be a user.
- **Owner**: the user who created a row (`owner_user_id`). Ownership decides who may delete it, not what it may read.
- **Caller**: who calls a tool (`ToolCaller`).
- **Origin**: where a call comes from: a signed-in user calling directly (origin kind `person`, holding a `users` id),
  or a run (by kind: interactive, routine, synthesis, summarization).
  A cloud session calls as an interactive run.
- **On behalf of**: whose private data a call or run may use (`onBehalfOf`). Null means the workspace's shared data only.
- **Workspace**: a team's shared space and tenant boundary. The UI says "team".

## Data

- **Connection**: an account linked to Draft (Slack, GitHub, a remote MCP server). Table `connections`.
- **Integration**: the user-facing word for a provider a person can connect. Not a table.
- **Source item**: one piece of ingested content (a meeting, a message, a captured session). Table `source_items`.
- **Context**: the company brain: synthesized documents by dimension, versioned in `workspace_context_versions`.
- **Synthesis**: the run that updates context. UI: "Context update".
- **Summarization**: the run that summarizes captured sessions. UI: "Session summaries".
- **Skill**: a saved company procedure. Table `skills`.

## Session traffic

- **Input**: something sent to a session that the agent has not taken yet: a message or a control (`session_inputs`).
- **Event**: one item in a session's feed (`session_events`). Not a workspace event (`workspace_events`) or an
  inbox event that can start a routine (`agent_event_inbox`).
- **Approval**: a person allowing or denying a tool call the agent asked for. Not the Codex approval *mode* setting.
