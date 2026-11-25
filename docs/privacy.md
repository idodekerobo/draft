# Privacy

Draft has two deployment modes. The data boundary is different in each mode:

- In hosted mode, your workspace data is processed by the Draft-hosted web app, API, database/storage services, integration workers, and sandboxed synthesis infrastructure.
- In self-hosted mode, the same components run in infrastructure selected and operated by you. The self-hosting operator controls the deployment, provider accounts, and retention configuration available outside the application.

## What Draft stores

Depending on the features you enable, the Draft deployment stores:

- User accounts, organizations, teams, workspace membership, and invite state.
- Versioned workspace context.
- Source items from connected services and uploaded source material.
- Coding-agent session metadata and captured transcript content.
- Synthesis runs, statuses, bounded run bundles, and results.
- Notifications: when Draft or an agent tells you something in the app, by email or in Slack, Draft stores the message (subject and text, and the HTML for an email) and the delivery status of each send, so you and the sender can look back at it. A private notification can be read only by its recipient and its sender. Draft does not track whether an email was opened. The message content stays stored with the notification.
- Encrypted provider credentials needed to connect integrations or run synthesis.

The backend enforces workspace access in its authenticated routes and database policies. Do not connect a source unless you are comfortable with the resulting data being available to the workspace members authorized to access it.

## Encryption and sensitive data

The backend application-encrypts provider credentials and session-ingest secrets before storing them in the credentials table. The encryption key is supplied to the backend through versioned `INFERENCE_CREDENTIAL_KEK_<VERSION>` environment variables; ordinary client queries do not receive the encrypted payload.

This is not a claim that every workspace record has a separate application-level encryption layer. Context documents, source items, transcripts, synthesis metadata, and run bundles rely on the configured Supabase/Postgres/storage controls, transport security, access policies, and the infrastructure operator's retention and encryption settings. Self-hosting operators should review those settings for their deployment.

## What stays on the local machine

The desktop and CLI keep local authentication state, project configuration, hook files, temporary files, and runtime logs. A local agent hook reads a completed transcript before uploading it to the configured Draft API. Local source folders remain local unless you explicitly import or upload them.

The local machine is not the canonical home of hosted workspace context. Clients request the current context from the deployment.

## Agent access

The remote MCP server provides authenticated, read-only access to workspace context and shared skills for connected agents. MCP calls are resolved against the caller's team workspace and checked against workspace access. The CLI uses authenticated API calls to read the same workspace and can also write project-local setup files or upload sessions when those features are enabled.

## Gmail

When you connect Google, Draft reads your Gmail live, with your own Google login, only when an agent asks. Draft does not copy or store your mail. Only your own agents can read it, plus the routines where you turn on **Read my Gmail**. Teammates and their agents cannot. Google consent requests read-only Gmail and Drive access; partial grants work. Your Google refresh token is encrypted like other credentials. When you disconnect Gmail, Draft stops using that connection. The shared Google credential is revoked once no live Google product uses it. Gmail search terms are not written to Draft's logs. If a captured coding session used a Gmail tool, Draft makes that session's summary private to you.

Known gap: the raw transcript of a captured session is still visible to your teammates. If a session read your mail, parts of it can show in that transcript.

## Context export

You can export your workspace context as markdown files from the web app, desktop app, CLI, or an MCP agent. An export is a copy that lives outside Draft's access control: anyone who has the files can read them, and removing a member from the workspace does not delete files they already exported. Agent download links expire after 5 minutes and re-check the user's workspace access when opened, but they are not single-use.

## Hosted processing

Hosted Draft processes workspace data on Draft infrastructure to provide authentication, integrations, context storage, and synthesis. Synthesis runs use disposable Fly Machines. Connected providers may also process data under their own terms when Draft calls their APIs or receives their webhooks.

Draft's hosted privacy policy and terms govern the hosted service. This repository's documentation describes the open-source implementation and cannot replace those policies.

## Self-hosted processing

In a self-hosted deployment, you choose and operate the Supabase, Bun backend, Fly Machines, web app, and related provider accounts. Configure the desktop and CLI to use your deployment URLs. Data sent through those clients goes to the configured deployment rather than Draft's hosted API.

Self-hosting does not automatically remove third-party processing. Supabase, Fly, connected integrations, and any model/provider credentials used by the deployment remain separate services with their own terms and controls.

## Analytics

Product analytics are on by default for new accounts, and anyone can turn them off with **Share usage data** in Settings. While it is on, the web and desktop apps send coded usage events to PostHog, linked to that person's Draft account id and email address. The choice is stored on the account, so it covers both apps. Session replay runs with it and records the text on screen, including content such as meeting quotes and names. Your messages to agents are recorded too. Passwords, API keys and tokens, and the repository and branch fields, are excluded. Usage events themselves carry no context, file or message content. Builds without a PostHog key send nothing. See [analytics.md](analytics.md) for the full event list, identifiers, and how to withdraw or ask for deletion.

## Team collaboration

Hosted team collaboration uses Draft organizations, teams, workspaces, and invite links. It does not require putting the company brain in a GitHub repository. GitHub can still be connected as a source or used for import.

## See also

- [What is Draft](./overview.md)
- [Architecture](./architecture.md)
- [Hosted team collaboration](./setting-up-collaboration.md)
- [MCP and agent connections](./mcp.md)

## Google Drive

Choosing a synced Google Drive folder is consent to put every native Google Doc,
Sheet and Slide in it into shared company context, including files only the person
who chose the folder can see. A shared drive can also be synced. The folder browser
states this before folders are added. Google access is read-only: Draft does not
edit, move or delete files in Google Drive. Gmail remains private and is not synced.

Draft stores rendered file content, comments and captured versions. Workspace
members and their agents can read those shared copies, including version history.
Only the person who added a synced folder may remove it. If a file is trashed,
removed or leaves every synced folder, sync marks all its captured versions deleted
and clears their text and structured content. Removing a synced folder takes effect
when sync next checks its files. Facts already synthesized into company context
are not retroactively removed by disconnecting or removing a folder.

Disconnect stops new ingestion, releases the connection's synced folders, and keeps
captured Drive files. Another connection may sync those folders later. The encrypted
Google credential is shared with Gmail and is revoked only when no live Google
connection uses it. A stale latest read can refresh using the asker's own Drive
login; without one it returns the stored copy and labels it stale. Historical reads
never fetch historical revisions from Google. Versions are retained without pruning.
