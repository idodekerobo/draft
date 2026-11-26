import { sumRunUsage, type RunUsage } from "draft-core/run-usage";
import type { RunnerSide } from "draft-core/harnesses/types";

/** Adds up the usage a harness reports across its output lines. Null when no line reported any. */
export class UsageCollector {
  private readonly parts: RunUsage[] = [];

  constructor(private readonly side: RunnerSide) {}

  addLine(raw: string): void {
    const usage = this.side.usageOfLine(raw);
    if (usage) this.parts.push(usage);
  }

  addOutput(stdout: string): void {
    for (const line of stdout.split(/\r?\n/)) if (line) this.addLine(line);
  }

  total(): RunUsage | null {
    return this.parts.length > 0 ? sumRunUsage(this.parts) : null;
  }
}
