export type PaneState = "ready" | "composer_busy" | "permission" | "question" | "dialog";

const ESC = "\u001b";
const CSI = new RegExp(`${ESC}\\[([0-9;]*)([A-Za-z])`, "g");
const SOLID_RULE = /^─{10,}\s*$/;
const MAX_LINES_BELOW_COMPOSER = 3;
const DIALOG_LINES = 25;

const stripAnsi = (line: string) => line.replace(CSI, "").replace(/ /g, " ");

/** Text a person typed in this line: ANSI-dim text (placeholder and ghost suggestion) does not count. */
function typedText(raw: string): string {
  let dim = false;
  let typed = "";
  let last = 0;
  for (const match of raw.matchAll(CSI)) {
    if (!dim) typed += raw.slice(last, match.index);
    last = match.index + match[0].length;
    if (match[2] !== "m") continue;
    for (const code of match[1]!.split(";")) {
      if (code === "2") dim = true;
      else if (code === "" || code === "0" || code === "22") dim = false;
    }
  }
  if (!dim) typed += raw.slice(last);
  return typed.replace(/ /g, " ");
}

function findComposer(plain: string[]): { start: number; end: number } | null {
  let bottom = plain.length - 1;
  while (bottom >= 0 && plain[bottom]!.trim() === "") bottom--;
  for (let i = bottom, below = 0; i >= 0 && below <= MAX_LINES_BELOW_COMPOSER; i--) {
    if (SOLID_RULE.test(plain[i]!)) {
      for (let j = i - 1; j >= 0; j--) {
        if (!SOLID_RULE.test(plain[j]!)) continue;
        return plain[j + 1]?.startsWith("❯") ? { start: j + 1, end: i } : null;
      }
      return null;
    }
    if (plain[i]!.trim() !== "") below++;
  }
  return null;
}

/**
 * Reads the screen of a Claude Code pane, taken with ANSI escapes kept.
 * Only a composer with no typed text is `ready`. Anything else must wait.
 */
export function classifyPane(screen: string): PaneState {
  const raw = screen.split("\n");
  const plain = raw.map(stripAnsi);

  const composer = findComposer(plain);
  if (composer) {
    const text = raw
      .slice(composer.start, composer.end)
      .map((line, index) => typedText(index === 0 ? line.slice(line.indexOf("❯") + 1) : line))
      .join("")
      .trim();
    return text === "" ? "ready" : "composer_busy";
  }

  const bottom = plain.filter((line) => line.trim() !== "").slice(-DIALOG_LINES).join("\n");
  if (/Enter to select|↑\/↓ to navigate/.test(bottom)) return "question";
  if (/Do you want to|Esc to cancel · Tab to amend/.test(bottom)) return "permission";
  return "dialog";
}
