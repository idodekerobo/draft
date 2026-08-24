# Draft CLI

The Draft CLI is a thin authenticated client for the hosted or self-hosted Draft control plane. It is useful for scripts, agents, project setup, and coding-session access without opening the desktop app.

The CLI is also the current agent connection mechanism. That surface is evolving, so prefer the command help and this reference over older daemon or GitHub-sync documentation.

## Install

~~~bash
curl -fsSL https://raw.githubusercontent.com/idodekerobo/draft/main/scripts/install-cli.sh | bash
~~~

Released binaries currently support macOS arm64/x64 and Linux x64. The compiled binary is installed under ~/.draft/bin/draft and linked onto PATH.

## Configuration

The CLI defaults to:

- API: https://api.draftai.us
- App: https://app.draftai.us

For another deployment, set:

~~~env
DRAFT_API_BASE_URL=https://api.example.com
DRAFT_APP_URL=https://app.example.com
DRAFT_SUPABASE_URL=https://your-project.supabase.co
DRAFT_SUPABASE_PUBLISHABLE_KEY=your-public-key
~~~

The Supabase URL and publishable key are required by the compiled/source CLI auth path. They are public client values; never use the Supabase secret key in the CLI.

## Authentication

~~~bash
draft auth login
draft auth whoami
draft auth logout
~~~

Authentication uses browser/device pairing and stores the CLI session separately from desktop authentication.

## Context

~~~bash
draft context list
draft context read --dimension product
draft context read --all
~~~

Context reads go through the authenticated API and return the current workspace snapshot. A missing workspace is an account/onboarding state, not a local initialization step.

## Project agent setup

Use draft add to write a managed Draft context block to a project's instruction file:

~~~bash
draft add claude-code --dir /path/to/project
draft add codex --dir /path/to/project
draft add cursor --dir /path/to/project
~~~

The command is project-local. It does not install a global daemon or initialize a local company-brain repository. The generated instructions tell the agent how to use the CLI to read the current workspace.

## Coding sessions

Enable Claude Code session capture for a project:

~~~bash
draft sessions enable claude-code --dir /path/to/project
draft sessions status --dir /path/to/project
draft sessions disable --dir /path/to/project
~~~

The enable command writes a project-local capture script and SessionEnd hook. The hook reads the completed transcript locally and posts it to the configured API.

List and inspect captured sessions:

~~~bash
draft sessions list
draft sessions search "pattern"
draft sessions read <session-id> --summary
draft sessions read <session-id> --transcript
~~~

Session listing and reading are workspace-scoped and require authentication.

## Output and updates

Commands support --json for machine-readable output. draft update checks for and installs a newer compiled release. Updates replace the CLI binary; they do not replace the server-side workspace.

Run draft --help for the authoritative command list and flags.
