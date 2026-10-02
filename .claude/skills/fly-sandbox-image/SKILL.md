---
name: fly-sandbox-image
description: Rebuild, push and roll out the Fly sandbox image after changing its Dockerfile/entrypoint/runner or the backend-to-runner contract, or provision a new Fly sandbox app for a new environment. Use before calling any such change done. Updates the environment's FLY_SANDBOX_IMAGE (and FLY_APP_NAME when applicable), including the production host.
---

# Skill: fly-sandbox-image

A backend deploy does not rebuild the sandbox image. Each environment runs the
digest in its `FLY_SANDBOX_IMAGE` setting, so an old image keeps running old
runner code with no error. A stale prod image once hid a summarization failure
for weeks. A change is not done until the image is rolled out.

Covers:

- **Image-only change** (same app, new build): new digest, update
  `FLY_SANDBOX_IMAGE` only.
- **New environment** (new Fly app): `fly apps create`, first build, set both
  `FLY_APP_NAME` and `FLY_SANDBOX_IMAGE`.

## When to invoke

- Any edit under `backend/src/sandbox/claude-code/` (`Dockerfile`,
  `entrypoint.sh`, `configure-egress.sh`, `runner.ts`).
- Bumping `CLAUDE_CODE_VERSION` in the Dockerfile.
- Any change to what the backend sends to the runner or expects back: env vars
  in `fly-sandbox-run.ts`, bundle layout, callback body shape.
- Standing up a new deployment target (staging, a second prod region, a
  customer-dedicated environment) that needs its own Fly app.

## Why this is required every time

`backend/src/sandbox/config.ts` validates `FLY_SANDBOX_IMAGE` against:

```
registry.fly.io/<app>@sha256:<64-hex-digest>
```

No tags allowed, only an immutable digest. There is no "latest" floating
reference, so a new build always produces a new digest that must be pushed into
the target environment's config. Nothing automates this.

## Recipe

### 0. Pick the environment

Work from the env file of the environment you are changing (see the
`staging-env` skill for which file is which). It holds `FLY_APP_NAME`,
`FLY_API_TOKEN` and `FLY_SANDBOX_IMAGE`. Build into that environment's Fly app.
Never build into one app and point another environment at it unless the user
says so.

| Environment | Fly app | Env file |
|---|---|---|
| production | `draft-sandbox-prod` | `.env.production` (and Railway) |
| staging | `draft-sandbox-staging` | `.env.staging` |

Do staging first, check it, then production. The same code builds the same
digest in both apps, so a matching digest confirms they run the same image.

New environment: pick a name and confirm it with the user before
`fly apps create` (not obviously reversible).

### 1. Test first

```bash
cd backend && bun test src/__tests__/sandbox src/__tests__/summarization src/__tests__/synthesis
sh -n src/sandbox/claude-code/entrypoint.sh src/sandbox/claude-code/configure-egress.sh
```

### 2. (New app only) Create the Fly app

```bash
fly apps create <app-name>
```

### 3. Build and push via Fly's remote builder

There is no `fly.toml` in the repo. Generate a throwaway config for the build:

```bash
cat > /tmp/<app-name>-build.toml <<EOF
app = "<app-name>"
primary_region = "iad"
EOF

fly deploy --build-only --push --app <app-name> \
  --config /tmp/<app-name>-build.toml \
  backend/src/sandbox/claude-code

rm -f /tmp/<app-name>-build.toml
```

Pass `FLY_API_TOKEN` from the env file as an environment variable. Strip any
inline `# comment` after the value first, and never print it.

### 4. Capture and verify the digest

The build output ends with a line like:

```
pushing manifest for registry.fly.io/<app-name>:deployment-XXXX@sha256:<digest>
```

Take the `sha256:<digest>` part (the manifest digest, not a layer digest) and
construct `registry.fly.io/<app-name>@sha256:<digest>`.

Check the registry, not only the build log: the image's created date is today,
and the `runner.mjs` layer contains a string you just added. Use the registry
API with basic auth (`x:<FLY_API_TOKEN>`) against
`https://registry.fly.io/v2/<app-name>/manifests/<digest>`.

Record the **previous** digest from the environment's current setting. It is the
rollback.

### 5. Roll out (needs explicit user approval)

Show the user the new digest and the previous digest, then wait for approval.
Never change an environment's image without it. Keep the backend compatible with
the previous image until this step.

After approval, set `FLY_SANDBOX_IMAGE` where that environment runs:

- **Production host (Railway):** update the variable with the Railway CLI. Invoke
  the `use-railway` skill if you need help with the CLI or the linked context
  (`railway status` shows the project, environment and service):
  ```bash
  railway variable set FLY_SANDBOX_IMAGE=registry.fly.io/<app>@sha256:<digest> \
    --service draft --environment production
  ```
  Railway redeploys the backend on a change. `.railway/railway.ts` marks the
  variable `preserve()`, so it is managed outside code. Then check the new
  deployment reaches `SUCCESS`.
- **Local or staging:** edit `FLY_SANDBOX_IMAGE` (and `FLY_APP_NAME` for a new
  app) in that environment's env file.
- **New app:** also set `FLY_APP_NAME=<app-name>`, and confirm `FLY_API_TOKEN` is
  valid for the new app. A token scoped to another app fails `fly machine run`
  against this one.

**Tell the user what changed on the production host:** the variable, service and
environment, the new and previous digests, and that Railway is redeploying. Do
not leave the production update for the user to do.

### 6. Confirm

After the next run on the new image, read the app logs
(`fly logs -a <app> --no-tail`) for `callback_delivered` and no `runner_error`.
Machines destroy themselves on exit, so logs only last a short time. In the PR
description, say whether the image was rebuilt and which digest each environment
now runs.

### Rollback

Set the variable back to the previous digest the same way. Old digests stay in
the registry.

## Gotchas (from `research/spikes/spike-2-fly-machines/results.md`)

- Fly's remote builder is more reliable than local `docker build` +
  `docker push`. Always use `--push` with the remote builder. Do not build
  locally on Apple Silicon and push separately (arch/cache mismatches).
- Use `--rm` / one-shot semantics on any `fly machine run` invocation of this
  image. The default restart policy (`always`) is wrong for one-shot jobs and
  will restart-loop up to Fly's cap.
- `claude -p` inside the container can report a non-zero/timeout exit code even
  after finishing correctly. Judge success by the result payload, not the
  process exit code, when debugging a bad rollout.
