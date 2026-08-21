import { closeSync, createReadStream, createWriteStream, openSync } from "fs";
import { createInterface } from "readline/promises";

export interface SelectableChannel {
  id: string;
  name: string;
  memberCount: number;
  isMember: boolean;
}

export class ChannelSelectionInterruptedError extends Error {
  constructor() {
    super("interrupted");
    this.name = "ChannelSelectionInterruptedError";
  }
}

export interface ChannelSelector {
  // Returns the full desired set of channel ids, or null if the tty is unavailable
  // or the typed selection could not be parsed. Throws ChannelSelectionInterruptedError
  // if `signal` aborts while waiting on input.
  select(channels: SelectableChannel[], signal?: AbortSignal): Promise<string[] | null>;
}

export class TtyChannelSelector implements ChannelSelector {
  async select(channels: SelectableChannel[], signal?: AbortSignal): Promise<string[] | null> {
    if (channels.length === 0) return [];
    if (signal?.aborted) throw new ChannelSelectionInterruptedError();
    let fd: number;
    try {
      fd = openSync("/dev/tty", "r+");
    } catch {
      return null;
    }
    const input = createReadStream("/dev/null", { fd, autoClose: false });
    const output = createWriteStream("/dev/null", { fd, autoClose: false });
    try {
      const rl = createInterface({ input, output, terminal: true });
      try {
        output.write("Select Slack channels (comma-separated numbers, \"all\", or blank for none):\n");
        channels.forEach((channel, index) => {
          output.write(`  ${index + 1}. #${channel.name}${channel.isMember ? " (current)" : ""}\n`);
        });
        let answer: string;
        try {
          answer = (signal ? await rl.question("> ", { signal }) : await rl.question("> ")).trim();
        } catch (error) {
          if (signal?.aborted) throw new ChannelSelectionInterruptedError();
          throw error;
        }
        if (signal?.aborted) throw new ChannelSelectionInterruptedError();
        if (answer.length === 0) return [];
        if (answer.toLowerCase() === "all") return channels.map((channel) => channel.id);
        const selected: string[] = [];
        for (const rawPart of answer.split(",")) {
          const part = rawPart.trim();
          if (part.length === 0) continue;
          const index = Number(part);
          if (!Number.isInteger(index) || index < 1 || index > channels.length) return null;
          selected.push(channels[index - 1]!.id);
        }
        return [...new Set(selected)];
      } finally {
        rl.close();
      }
    } finally {
      input.destroy();
      output.destroy();
      try { closeSync(fd); } catch {}
    }
  }
}

export const channelSelector: ChannelSelector = new TtyChannelSelector();
