import type { ElectrobunConfig } from "electrobun";

// Read PostHog key + host from build-config.json at config evaluation time.
// Absent for OSS builds → empty string → phTrack no-ops in the main process.
let _buildCfg: { posthog_key?: string; api_host?: string } = {};
try {
  const raw = await Bun.file(new URL("./src/build-config.json", import.meta.url).pathname).text();
  _buildCfg = JSON.parse(raw) as { posthog_key?: string; api_host?: string };
} catch { /* no build-config.json — OSS build */ }

const _phKey  = JSON.stringify(_buildCfg.posthog_key ?? "");
const _phHost = JSON.stringify(_buildCfg.api_host    ?? "https://us.i.posthog.com");

export default {
  app: {
    name: "Draft",
    identifier: "us.draftai.draft-desktop",
    version: "0.2.1",
  },
  runtime: {
    exitOnLastWindowClosed: false,
  },
  build: {
    bun: {
      entrypoint: "src/index.ts",
      define: {
        "process.env.DRAFT_PH_KEY":  _phKey,
        "process.env.DRAFT_PH_HOST": _phHost,
      },
    },
    views: {
      app: {
        entrypoint: "src/app/index.tsx",
      },
    },
    copy: {
      "src/app/index.html": "views/app/index.html",
      "src/app/index.css":  "views/app/index.css",
      // Bundled at build time by desktop/scripts/prebuild.sh
      "assets/background/": "background/",
      "assets/plugin/":     "plugin/",
    },
    mac: {
      icons: "assets/icon.iconset",
      codesign: true,
      notarize: true,
    },
  },
  scripts: {
    postBuild: "scripts/postbuild.ts",
  },
} satisfies ElectrobunConfig;
