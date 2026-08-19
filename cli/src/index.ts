#!/usr/bin/env bun
// index.ts — Draft CLI entry point and command router

import { printHelp, red } from "./utils/output.ts";

import { runAdd } from "./commands/add.ts";
import { runAuth } from "./commands/auth.ts";
import { runContext } from "./commands/context.ts";
import { runSessions } from "./commands/sessions.ts";
import { runCompletion } from "./commands/completion.ts";

const args = process.argv.slice(2);
const command = args[0];
const rest = args.slice(1);

if (!command || command === "--help" || command === "-h") {
  printHelp();
  process.exit(0);
}

(async () => {
  switch (command) {
    case "add":
      process.exitCode = await runAdd(rest);
      break;
    case "auth":
      process.exitCode = await runAuth(rest);
      break;
    case "context":
      process.exitCode = await runContext(rest);
      break;
    case "sessions":
      process.exitCode = await runSessions(rest);
      break;
    case "completion":
      await runCompletion(rest);
      break;
    default:
      console.error(red(`Unknown command: ${command}`));
      console.error(`Run ${"`draft`"} to see the full command list.`);
      process.exitCode = 2;
  }
})().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(red(`Draft could not start safely: ${message}`));
  process.exitCode = 1;
});
