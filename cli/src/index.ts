#!/usr/bin/env bun
// index.ts — Draft CLI entry point and command router

import { printHelp, red } from "./utils/output.ts";

import { runStatus, runStart, runStop, runLogs } from "./commands/daemon.ts";
import { runAdd } from "./commands/add.ts";
import { runSwitch } from "./commands/switch.ts";
import { runProfiles } from "./commands/profiles.ts";
import { runPublish, runLoad } from "./commands/sync.ts";
import { runProposals } from "./commands/proposals.ts";
import { runDoctor } from "./commands/doctor.ts";
import { runCompletion } from "./commands/completion.ts";
import { runUninstall } from "./commands/uninstall.ts";
import { runUpdate } from "./commands/update.ts";
import { runPoll } from "./commands/poll.ts";

const args = process.argv.slice(2);
const command = args[0];
const rest = args.slice(1);

if (!command || command === "--help" || command === "-h") {
  printHelp();
  process.exit(0);
}

(async () => {
  switch (command) {
    case "status":
      await runStatus(rest);
      break;
    case "start":
      await runStart(rest);
      break;
    case "stop":
      await runStop(rest);
      break;
    case "logs":
      await runLogs(rest);
      break;
    case "add":
      await runAdd(rest);
      break;
    case "switch":
      await runSwitch(rest);
      break;
    case "profiles":
      await runProfiles(rest);
      break;
    case "publish":
      await runPublish(rest);
      break;
    case "load":
      await runLoad(rest);
      break;
    case "proposals":
      await runProposals(rest);
      break;
    case "doctor":
      await runDoctor(rest);
      break;
    case "completion":
      await runCompletion(rest);
      break;
    case "uninstall":
      await runUninstall(rest);
      break;
    case "update":
      await runUpdate(rest);
      break;
    case "poll":
      await runPoll(rest);
      break;
    default:
      console.error(red(`Unknown command: ${command}`));
      console.error(`Run ${"`draft`"} to see the full command list.`);
      process.exit(1);
  }
})();
