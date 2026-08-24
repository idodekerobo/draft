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
- Encrypted provider credentials needed to connect integrations or run synthesis.

The backend enforces workspace access in its authenticated routes and database policies. Do not connect a source unless you are comfortable with the resulting data being available to the workspace members authorized to access it.

## Encryption and sensitive data

The backend application-encrypts provider credentials and session-ingest secrets before storing them in the credentials table. The encryption key is supplied to the backend through versioned `INFERENCE_CREDENTIAL_KEK_<VERSION>` environment variables; ordinary client queries do not receive the encrypted payload.

This is not a claim that every workspace record has a separate application-level encryption layer. Context documents, source items, transcripts, synthesis metadata, and run bundles rely on the configured Supabase/Postgres/storage controls, transport security, access policies, and the infrastructure operator's retention and encryption settings. Self-hosting operators should review those settings for their deployment.

## What stays on the local machine

The desktop and CLI keep local authentication state, project configuration, hook files, temporary files, and runtime logs. A local agent hook reads a completed transcript before uploading it to the configured Draft API. Local source folders remain local unless you explicitly import or upload them.

The local machine is not the canonical home of hosted workspace context. Clients request the current context from the deployment.

## Hosted processing

Hosted Draft processes workspace data on Draft infrastructure to provide authentication, integrations, context storage, and synthesis. Synthesis runs use disposable Fly Machines. Connected providers may also process data under their own terms when Draft calls their APIs or receives their webhooks.

Draft's hosted privacy policy and terms govern the hosted service. This repository's documentation describes the open-source implementation and cannot replace those policies.

## Self-hosted processing

In a self-hosted deployment, you choose and operate the Supabase, Bun backend, Fly Machines, web app, and related provider accounts. Configure the desktop and CLI to use your deployment URLs. Data sent through those clients goes to the configured deployment rather than Draft's hosted API.

Self-hosting does not automatically remove third-party processing. Supabase, Fly, connected integrations, and any model/provider credentials used by the deployment remain separate services with their own terms and controls.

## Analytics

The desktop and landing applications have optional analytics configuration. Review the configured PostHog and support settings for the deployment before enabling them. Do not assume hosted and self-hosted analytics have the same destination.

## Team collaboration

Hosted team collaboration uses Draft organizations, teams, workspaces, and invite links. It does not require putting the company brain in a GitHub repository. GitHub can still be connected as a source or used for import.

## See also

- [What is Draft](./overview.md)
- [Architecture](./architecture.md)
- [Hosted team collaboration](./setting-up-collaboration.md)
