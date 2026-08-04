# Claude Code sandbox image

Production-shaped one-shot runner for Fly Machines. Root configures IPv4 and
IPv6 default-deny egress, then the trusted runner invokes Claude as the
unprivileged `agent` user and reports the atomically committed result.

Required runtime environment:

- `DRAFT_RUN_ID`, `DRAFT_BUNDLE_HASH`
- `DRAFT_CALLBACK_URL`, `DRAFT_CALLBACK_TOKEN`
- `CLAUDE_CODE_OAUTH_TOKEN`
- `DRAFT_EGRESS_HOSTS` for any additional HTTPS hosts (Anthropic and the
  callback hostname are added automatically)

Optional: `DRAFT_PROMPT_PATH` (default `/run/input/prompt.md`) and
`DRAFT_TIMEOUT_SECONDS` (default 300, maximum 3600).

Build from this directory with Fly's remote builder. Run one-shot Machines
with `--rm`; the spike found Fly's default restart policy inappropriate for
jobs.

Local validation (from `backend`):

```sh
bun test src/__tests__/sandbox/claude-code/runner.test.ts
sh -n src/sandbox/claude-code/entrypoint.sh src/sandbox/claude-code/configure-egress.sh
docker build src/sandbox/claude-code
```
