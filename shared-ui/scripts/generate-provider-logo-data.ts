import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const sourceDir = join(import.meta.dir, "../src/integrations/logos");
const output = join(import.meta.dir, "../src/integrations/provider-logo-assets.ts");
const assets = {
  slack: "slack.svg",
  github: "github.svg",
  linear: "linear.svg",
  fireflies: "fireflies.ai.png",
  granola: "granola.ai.png",
} as const;

const data = Object.entries(assets).map(([name, filename]) => {
  const mime = filename.endsWith(".svg") ? "image/svg+xml" : "image/png";
  const encoded = readFileSync(join(sourceDir, filename)).toString("base64");
  return `  ${name}: ${JSON.stringify(`data:${mime};base64,${encoded}`)},`;
});

writeFileSync(output, `// Generated from the adjacent provider logo files. Keep those files as source assets.\nexport const PROVIDER_LOGO_DATA = {\n${data.join("\n")}\n} as const;\n`);
