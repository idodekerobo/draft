// Checks tokens.css: AA contrast on both palettes, light blocks in sync, and
// no var(--*) used in the given CSS files without a definition.
// Usage: bun shared-ui/scripts/check-tokens.ts [extra.css ...]
import { readFileSync } from "node:fs";
import { join } from "node:path";

const tokensPath = join(import.meta.dir, "../src/styles/tokens.css");
const tokensCss = readFileSync(tokensPath, "utf8");

function block(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`Missing block ${selector}`);
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
  const vars: Record<string, string> = {};
  for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars[match[1]!] = match[2]!.trim();
  return vars;
}

type Rgba = [number, number, number, number];

function parseColor(value: string, vars: Record<string, string>): Rgba {
  const ref = value.match(/^var\((--[\w-]+)\)$/);
  if (ref) return parseColor(vars[ref[1]!]!, vars);
  const hex = value.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const rgba = value.match(/^rgba?\(([^)]+)\)$/);
  if (rgba) {
    const [r, g, b, a = "1"] = rgba[1]!.split(",").map((part) => part.trim());
    return [Number(r), Number(g), Number(b), Number(a)];
  }
  throw new Error(`Cannot parse color ${value}`);
}

function over(top: Rgba, bottom: Rgba): Rgba {
  const a = top[3];
  return [0, 1, 2].map((i) => top[i]! * a + bottom[i]! * (1 - a)).concat(1) as Rgba;
}

function luminance([r, g, b]: Rgba): number {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(fg: Rgba, bg: Rgba): number {
  const [a, b] = [luminance(over(fg, bg)), luminance(bg)].sort((x, y) => y - x);
  return (a! + 0.05) / (b! + 0.05);
}

const dark = block(tokensCss, ":root {");
const light = { ...dark, ...block(tokensCss, ':root[data-theme="light"]') };
const lightMedia = block(tokensCss, ":root:not([data-theme])");
const failures: string[] = [];

for (const [name, value] of Object.entries(block(tokensCss, ':root[data-theme="light"]'))) {
  if (lightMedia[name] !== value) failures.push(`light media block differs on ${name}`);
}

const textTokens = ["--color-text-primary", "--color-text-secondary", "--color-text-tertiary", "--color-accent-text", "--color-status-green", "--color-status-yellow", "--color-status-red"];
const backgrounds = ["--color-bg-primary", "--color-bg-sidebar", "--color-bg-elevated", "--color-selected-bg"];

for (const [theme, vars] of [["dark", dark], ["light", light]] as const) {
  for (const bgName of backgrounds) {
    const bg = parseColor(vars[bgName]!, vars);
    for (const fgName of textTokens) {
      const ratio = contrast(parseColor(vars[fgName]!, vars), bg);
      const line = `${theme.padEnd(5)} ${fgName} on ${bgName}: ${ratio.toFixed(2)}`;
      if (ratio < 4.5) failures.push(line);
      else console.log(`ok   ${line}`);
    }
  }
  const onAccent = contrast(parseColor(vars["--color-text-on-accent"]!, vars), parseColor(vars["--color-accent-fill"]!, vars));
  if (onAccent < 4.5) failures.push(`${theme} text-on-accent on accent-fill: ${onAccent.toFixed(2)}`);
  else console.log(`ok   ${theme.padEnd(5)} text-on-accent on accent-fill: ${onAccent.toFixed(2)}`);
  const selected = contrast(parseColor(vars["--color-selected-text"]!, vars), parseColor(vars["--color-selected-bg"]!, vars));
  if (selected < 4.5) failures.push(`${theme} selected text on selected background: ${selected.toFixed(2)}`);
  const border = contrast(parseColor(vars["--color-border-strong"]!, vars), parseColor(vars["--color-bg-primary"]!, vars));
  if (border < 3) failures.push(`${theme} strong control border on page background: ${border.toFixed(2)}`);
  const focus = contrast(parseColor(vars["--color-focus"]!, vars), parseColor(vars["--color-bg-primary"]!, vars));
  if (focus < 3) failures.push(`${theme} focus indicator on page background: ${focus.toFixed(2)}`);
}

const defined = new Set(Object.keys(dark));
for (const file of process.argv.slice(2)) {
  const css = readFileSync(file, "utf8");
  for (const match of css.matchAll(/(--[\w-]+)\s*:/g)) defined.add(match[1]!);
  for (const match of css.matchAll(/var\((--[\w-]+)/g)) {
    if (!defined.has(match[1]!)) failures.push(`${file}: undefined ${match[1]}`);
  }
}

if (failures.length) {
  console.error(`\n${[...new Set(failures)].join("\n")}`);
  process.exit(1);
}
console.log("\nAll token checks passed.");
