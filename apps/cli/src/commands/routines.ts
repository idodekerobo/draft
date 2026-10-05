// commands/routines.ts — draft routines list

import { fetchRoutines, type FetchErrorCode, type RoutineSummary } from "../cloud-client.ts";
import { EXIT_OPERATIONAL_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR, errorPayload, printJsonLine } from "../utils/json-output.ts";
import { bold, dim, red } from "../utils/output.ts";

function fetchErrorPayload(code: FetchErrorCode) {
  if (code === "not_authenticated") return errorPayload(code, "Not signed in.", "draft auth login");
  if (code === "no_workspace") return errorPayload(code, "No workspace yet — finish onboarding in the Draft app.");
  return errorPayload(code, "Could not fetch routines right now. Retry shortly.");
}

function printFetchError(command: string, code: FetchErrorCode, json: boolean): void {
  const payload = fetchErrorPayload(code);
  if (json) { printJsonLine(payload); return; }
  console.error(red(`${command}: ${payload.message}${payload.action ? ` Run \`${payload.action}\`.` : ""}`));
}

function formatRoutine(routine: RoutineSummary): string {
  return [
    `${bold(routine.title)} — ${routine.enabled ? "enabled" : "disabled"}`,
    `  schedule: ${routine.scheduleDescription}`,
    ...(routine.cron ? [`  cron: ${routine.cron} (${routine.timezone})`] : []),
    `  next run: ${routine.nextRunAt ?? "none scheduled"}`,
  ].join("\n");
}

export async function runRoutinesList(args: string[]): Promise<number> {
  const json = args.includes("--json");
  const unknown = args.find((a) => a !== "--json");
  if (unknown) {
    if (json) printJsonLine(errorPayload("invalid_usage", `unexpected argument: ${unknown}`));
    else console.error(red(`draft routines list: unexpected argument: ${unknown}`));
    return EXIT_USAGE_ERROR;
  }

  const result = await fetchRoutines();
  if (!result.ok) {
    printFetchError("draft routines list", result.code, json);
    return EXIT_OPERATIONAL_ERROR;
  }

  if (json) {
    printJsonLine({ routines: result.value });
    return EXIT_SUCCESS;
  }
  if (result.value.length === 0) {
    console.log("No routines found.");
    return EXIT_SUCCESS;
  }
  console.log(result.value.map(formatRoutine).join("\n\n"));
  return EXIT_SUCCESS;
}

function printRoutinesHelp(): void {
  console.log(`${bold("draft routines")} — scheduled background tasks in the workspace.`);
  console.log("");
  console.log("Usage:");
  console.log(`  draft routines list [--json]   ${dim("List routines with schedule, cron, enabled state, next run")}`);
}

export async function runRoutines(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "--help" || sub === "-h" || sub === undefined) {
    printRoutinesHelp();
    return sub === undefined ? EXIT_USAGE_ERROR : EXIT_SUCCESS;
  }
  if (sub === "list") return runRoutinesList(rest);
  console.error(red(`draft routines: unknown subcommand "${sub}". Use list.`));
  return EXIT_USAGE_ERROR;
}
