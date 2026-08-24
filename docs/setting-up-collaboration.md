# Hosted team collaboration

Draft collaboration is centered on an authenticated organization, team, and workspace. A workspace is the shared company brain that authorized teammates and connected agents can use.

## Invite teammates

1. Sign up or sign in to Draft.
2. Open the desktop app and connect it to your workspace.
3. Use the onboarding collaboration step or the desktop invite flow to create an invite link.
4. Send the link to a teammate.
5. The teammate opens the link, signs in, and joins the workspace.

The web app handles invite acceptance. The desktop app displays the current workspace and its members' shared context.

## What is shared

Workspace members can access the context, source-derived updates, synthesis activity, and other data permitted by the workspace access model. Connected integrations and coding-agent session capture are configured against the workspace, so decide carefully who should be a member before enabling them.

The current workspace model supports multiple users and teams through the hosted API. It is the collaboration path for hosted Draft and for self-hosted deployments using the same backend.

## GitHub's role

GitHub is an integration and source of activity. Draft can receive GitHub App events, and the desktop can import a GitHub repository as source material during onboarding. GitHub is not the primary team-context synchronization layer.

The former workflow of publishing accepted context to a private GitHub repository and loading it into each local workspace is legacy. Do not use that workflow as the current setup path.

## Self-hosted collaboration

For a self-hosted deployment:

- Configure the web app and backend to use the same Supabase project.
- Configure the backend's APP_URL and DRAFT_API_BASE_URL for the deployed web/API origins.
- Configure the desktop and CLI to point to the self-hosted app/API/Supabase values.
- Invite teammates through the self-hosted web app and desktop flow.

The operator controls the deployment and its storage. Team members still authenticate individually and are authorized by the workspace access model.

## See also

- [What is Draft](./overview.md)
- [Architecture](./architecture.md)
- [Privacy](./privacy.md)
