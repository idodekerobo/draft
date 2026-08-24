import { createReadStream, createWriteStream, openSync } from "fs";
import { createInterface } from "readline/promises";
import { flushTtyOutput } from "./tty-stream-cleanup.ts";

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
  // if `signal` aborts while waiting on input. Note: a native read already
  // dispatched on the underlying TTY fd can't actually be cancelled -- it
  // only settles once more input arrives -- so the caller is responsible for
  // force-exiting after this rejects, once its own cleanup/messaging is
  // done, rather than relying on the process draining naturally.
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
      await flushTtyOutput(output);
      // Despite autoClose:false, destroying a stream backed by this fd
      // still closes it asynchronously (a Bun stream quirk) -- and since
      // `input` and `output` both wrap the SAME fd, destroying both (or
      // destroying one and then also closeSync'ing the fd ourselves) races
      // two or more independent closers against the same fd, throwing an
      // *uncaught* EBADF from whichever loses, well after this function has
      // returned. Destroying exactly one stream (never both, and no
      // separate manual close) is the only combination that closes the fd
      // without a race.
      input.destroy();
    }
  }
}

export const channelSelector: ChannelSelector = new TtyChannelSelector();
