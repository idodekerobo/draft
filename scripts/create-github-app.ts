#!/usr/bin/env bun
// One-off GitHub App registration via the manifest flow. Not part of the
// running backend — run manually per environment (dev, then prod once a
// real backend URL exists):
//
//   bun run scripts/create-github-app.ts
//   bun run scripts/create-github-app.ts \
//     --webhook-url https://api.draftai.us/webhooks/github \
//     --setup-url https://api.draftai.us/workspaces/github/callback \
//     --name "Draft Context"
//   bun run scripts/create-github-app.ts --org my-org-slug
//
// Opens a local page that auto-POSTs the manifest to GitHub, waits for
// GitHub's redirect back to the manifest's fixed localhost redirect_url,
// exchanges the resulting code for the App's credentials, and prints them
// ready to paste into the root .env.local (dev — forwarded to the backend
// process by scripts/run-local.sh's backend_env array) or Railway env vars
// (prod).

import { createPrivateKey, randomBytes } from "node:crypto";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      out[key] = "true";
    } else {
      out[key] = value;
      i++;
    }
  }
  return out;
}

async function openInBrowser(url: string): Promise<void> {
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    Bun.spawn([opener, url], { stdout: "ignore", stderr: "ignore" });
  } catch {
    console.log(`Could not auto-open a browser. Open this URL manually:\n  ${url}`);
  }
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = args.manifest ?? "backend/src/ingestion/github/github-app-manifest.json";
  const manifest = await Bun.file(manifestPath).json();

  if (args.name) manifest.name = args.name;
  if (args["webhook-url"]) {
    manifest.hook_attributes = { ...manifest.hook_attributes, url: args["webhook-url"] };
  }
  if (args["setup-url"]) manifest.setup_url = args["setup-url"];

  const redirectUrl: string = manifest.redirect_url;
  if (!redirectUrl || !redirectUrl.startsWith("http://localhost")) {
    throw new Error(
      `manifest.redirect_url must be a localhost URL for this script's one-time registration callback (got ${redirectUrl}).`,
    );
  }
  const port = Number(new URL(redirectUrl).port);
  const callbackPath = new URL(redirectUrl).pathname;

  const state = randomBytes(16).toString("hex");
  const createUrl = args.org
    ? `https://github.com/organizations/${args.org}/settings/apps/new?state=${state}`
    : `https://github.com/settings/apps/new?state=${state}`;

  const localPageHtml = `<!doctype html>
<html><body>
<form id="f" action="${escapeHtml(createUrl)}" method="post">
  <input type="hidden" name="manifest" value='${escapeHtml(JSON.stringify(manifest))}'>
</form>
<p>Redirecting to GitHub…</p>
<script>document.getElementById("f").submit();</script>
</body></html>`;

  let resolveCode: (code: string) => void;
  let rejectCode: (err: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = Bun.serve({
    port,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/" ) {
        return new Response(localPageHtml, { headers: { "content-type": "text/html" } });
      }
      if (url.pathname === callbackPath) {
        const code = url.searchParams.get("code");
        const returnedState = url.searchParams.get("state");
        if (!code) {
          rejectCode(new Error(`GitHub redirect missing ?code (query: ${url.search})`));
          return new Response("Missing code — check the terminal.", { status: 400 });
        }
        if (returnedState !== state) {
          rejectCode(new Error("state mismatch on GitHub redirect — possible CSRF, aborting"));
          return new Response("State mismatch — check the terminal.", { status: 400 });
        }
        resolveCode(code);
        return new Response(
          "<!doctype html><body>App created. You can close this tab and return to the terminal.</body>",
          { headers: { "content-type": "text/html" } },
        );
      }
      return new Response("not found", { status: 404 });
    },
  });

  console.log(`Local registration server listening on http://localhost:${port}`);
  console.log(`Opening browser to submit the manifest to GitHub…`);
  await openInBrowser(`http://localhost:${port}/`);

  let code: string;
  try {
    code = await codePromise;
  } finally {
    server.stop();
  }

  console.log("Exchanging code for App credentials…");
  const conversionRes = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
    method: "POST",
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!conversionRes.ok) {
    throw new Error(
      `manifest conversion failed: ${conversionRes.status} ${await conversionRes.text()}`,
    );
  }
  const app = await conversionRes.json();

  // GitHub returns the key as PKCS#1 ("BEGIN RSA PRIVATE KEY"), which jose's
  // importPKCS8 (used by ingestion/github/client.ts) can't parse -- convert
  // to PKCS#8 ("BEGIN PRIVATE KEY") before this ever reaches an env file.
  const pkcs8Pem = createPrivateKey({ key: app.pem as string, format: "pem" })
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  const pemOneLine = pkcs8Pem.replace(/\r?\n/g, "\\n");

  console.log("\nGitHub App created. Paste these into the root .env.local (dev) or Railway env vars (prod):\n");
  console.log(`GITHUB_APP_ID=${app.id}`);
  console.log(`GITHUB_APP_SLUG=${app.slug}`);
  console.log(`GITHUB_APP_WEBHOOK_SECRET=${app.webhook_secret}`);
  console.log(`GITHUB_APP_PRIVATE_KEY="${pemOneLine}"`);
  console.log(
    "\n(GITHUB_APP_PRIVATE_KEY is PKCS#8, stored with literal \\n escapes on one line — config.ts un-escapes it back to a real PEM at load time.)",
  );
  console.log(
    `\nWebhook URL is currently "${manifest.hook_attributes?.url}" and Setup URL is currently "${manifest.setup_url}" — edit either any time in the App's GitHub settings page (zero cost, just webform fields) once a real backend URL is deployed.`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
