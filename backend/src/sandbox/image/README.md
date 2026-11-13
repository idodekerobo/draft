# Sandbox image

The one-shot runner image for sandbox providers (Fly Machines today). Root
configures IPv4 and IPv6 default-deny egress, then the trusted runner starts the
harness (Claude Code or Codex) as the unprivileged `agent` user and reports the
result to the backend.

## What is in the image

- `runner.mjs`: the runner, bundled from `backend/src/sandbox/runner.ts`. It is
  not in git. `bun run build:runner` (from `backend`) writes it into this folder.
  The Dockerfile only copies it.
- `entrypoint.sh`, `configure-egress.sh`: the root bootstrap.
- The pinned `claude` and `codex` CLIs.

The bundle holds only runner-side code: `sandbox/runner.ts`, `sandbox/runner/*`,
`core/src/harnesses/*/runner.ts`, `core/src/harnesses/failure.ts`,
`core/src/run-manifest.ts` and `core/src/run-spec.ts`. It imports only Node
built-ins. `backend/src/__tests__/sandbox/runner-bundle.test.ts` fails if
anything else gets in.

A backend deploy does not rebuild this image. Rebuild and roll out the image
(the `fly-sandbox-image` skill) after changing any file above.

## Runtime environment

Set by the backend in `backend/src/sandbox/launch.ts`:

- `DRAFT_RUN_ID`, `DRAFT_BUNDLE_HASH`, `DRAFT_BUNDLE_URL`
- `DRAFT_CALLBACK_URL`, `DRAFT_CALLBACK_TOKEN`
- `DRAFT_RUN_MANIFEST`: what to run (harness, model, tools, output, timeout)
- The harness login: `CLAUDE_CODE_OAUTH_TOKEN` or `CODEX_AUTH_JSON`
- `DRAFT_RUN_TOKEN` when the run has Draft tools
- `DRAFT_EGRESS_HOSTS` for extra HTTPS hosts (the model provider and the
  callback host are added automatically)

## Failures

Any error after the callback variables are read is posted to the callback as
`{ error: "runner_error", diagnostics: { reason } }` and logged with the same
reason. In a batch, a single item that throws becomes an `ok: false` item and
the rest of the batch still reports.

Run one-shot Machines with `--rm`. Fly's default restart policy is wrong for
jobs.

## Local validation (from `backend`)

```sh
bun test src/__tests__/sandbox
bun run build:runner
sh -n src/sandbox/image/entrypoint.sh src/sandbox/image/configure-egress.sh
docker build src/sandbox/image
```
