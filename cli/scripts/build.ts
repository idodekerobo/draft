#!/usr/bin/env bun
// cli/scripts/build.ts — compiles the standalone draft-bin executable.
//
// The compiled binary is distributed without the end user exporting any
// env vars, so the public Supabase URL and anonymous key must be baked in
// at compile time via --define. Fails loudly and refuses to produce a
// binary if either is missing, rather than shipping one that can never
// authenticate.

const required = ["DRAFT_SUPABASE_URL", "DRAFT_SUPABASE_PUBLISHABLE_KEY"] as const;
const missing = required.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`draft-cli build failed: missing required env var(s): ${missing.join(", ")}`);
  console.error("Set DRAFT_SUPABASE_URL and DRAFT_SUPABASE_PUBLISHABLE_KEY before building draft-bin.");
  process.exit(1);
}

const supabaseUrl = process.env.DRAFT_SUPABASE_URL!;
const supabasePublishableKey = process.env.DRAFT_SUPABASE_PUBLISHABLE_KEY!;

const proc = Bun.spawn({
  cmd: [
    "bun", "build", "--compile",
    "--define", `process.env.DRAFT_SUPABASE_URL=${JSON.stringify(supabaseUrl)}`,
    "--define", `process.env.DRAFT_SUPABASE_PUBLISHABLE_KEY=${JSON.stringify(supabasePublishableKey)}`,
    "src/index.ts", "--outfile", "../draft-bin",
  ],
  cwd: import.meta.dir + "/..",
  stdout: "inherit",
  stderr: "inherit",
});
const exitCode = await proc.exited;
process.exit(exitCode);
