import { describe, expect, it } from "bun:test";
import { classifyPane } from "./pane-state";

const RULE = "─".repeat(120);
const DIM = "\u001b[2m";
const RESET = "\u001b[0m";
const NBSP = " ";

const header = " ▐▛███▛█   Claude Code v2.1.311\n▝▜██████▀  Haiku 5.5 · Claude Pro\n";
const screen = (composer: string, footer = "  ⏸ manual mode on · ? for shortcuts") =>
  `${header}\n${RULE}\n${composer}\n${RULE}\n${footer}\n`;

describe("classifyPane", () => {
  it("an empty composer with a dim placeholder is ready", () => {
    expect(classifyPane(screen(`\u001b[39m❯${NBSP}${DIM}Try "edit <filepath> to..."${RESET}`))).toBe("ready");
  });

  it("a dim ghost suggestion after a turn is not typed text", () => {
    expect(classifyPane(screen(`\u001b[39m❯${NBSP}${DIM}create nope.txt again${RESET}`))).toBe("ready");
  });

  it("typed text makes the composer busy", () => {
    expect(classifyPane(screen(`\u001b[39m❯${NBSP}partial text`))).toBe("composer_busy");
  });

  it("text typed after a dim part still counts", () => {
    expect(classifyPane(screen(`❯ ${DIM}ghost${RESET}typed`))).toBe("composer_busy");
  });

  it("a plain capture with a placeholder cannot be told from typed text, so it waits", () => {
    expect(classifyPane(screen('❯ Try "edit <filepath> to..."'))).toBe("composer_busy");
  });

  it("a composer with a second typed line is busy", () => {
    expect(classifyPane(screen("❯ first line\n  second line"))).toBe("composer_busy");
  });

  it("a turn in progress still shows a ready composer", () => {
    const working = `✻ Cooking… (12s · esc to interrupt)\n\n${RULE}\n❯ ${DIM}Try "fix lint errors"${RESET}\n${RULE}\n  ⏸ manual mode on\n`;
    expect(classifyPane(working)).toBe("ready");
  });

  it("a hint line below the composer is allowed", () => {
    expect(classifyPane(`${RULE}\n❯ ${DIM}x${RESET}\n${RULE}\n  ⏸ manual mode on\n  tmux focus-events off\n`)).toBe("ready");
  });

  it("recognises a permission prompt", () => {
    const permission = [
      "⏺ Write(hello.txt)",
      RULE,
      " Create file",
      " hello.txt",
      "╌".repeat(120),
      "  1 hi",
      "╌".repeat(120),
      " Do you want to create hello.txt?",
      " ❯ 1. Yes",
      "   2. Yes, and switch to accept edits (shift+tab)",
      "   3. No",
      " Esc to cancel · Tab to amend",
    ].join("\n");
    expect(classifyPane(permission)).toBe("permission");
  });

  it("recognises a question prompt", () => {
    const question = [
      "❯ Use the AskUserQuestion tool to ask me whether I prefer red or blue.",
      RULE,
      " ☐ Color",
      "Do you prefer red or blue?",
      "❯ 1. Red",
      "  2. Blue",
      "  3. Type something.",
      RULE,
      "  4. Chat about this",
      "Enter to select · ↑/↓ to navigate · Esc to cancel",
    ].join("\n");
    expect(classifyPane(question)).toBe("question");
  });

  it("an old permission question in the scrollback does not block a ready composer", () => {
    const old = `Do you want to create hello.txt?\n ❯ 1. Yes\n${screen(`❯ ${DIM}Try something${RESET}`)}`;
    expect(classifyPane(old)).toBe("ready");
  });

  it("a screen with no composer, like the trust dialog or a start-up screen, is a dialog", () => {
    expect(classifyPane(" Do you trust the files in this folder?\n ❯ 1. Yes, proceed\n   2. No, exit\n")).toBe("dialog");
    expect(classifyPane("Loading…\n")).toBe("dialog");
    expect(classifyPane("")).toBe("dialog");
  });
});
