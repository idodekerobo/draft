# Codex intelligence adapter

`codex.ts` runs the local Codex CLI for daemon based Codex session synthesis. The
desktop prebuild bundles it alongside the scanner and session synthesizer.

The adapter receives a prompt file and an output file path, writes the Codex
response to that output path, and exits nonzero when Codex fails or returns no
usable output.
