import type { ElectrobunConfig } from "electrobun";

// Read PostHog key + host from build-config.json at config evaluation time.
// Absent for OSS builds → empty string → phTrack no-ops in the main process.
let _buildCfg: { posthog_key?: string; api_host?: string; crisp_website_id?: string; crisp_history_endpoint?: string; crisp_history_secret?: string; cal_url?: string } = {};
try {
  const raw = await Bun.file(new URL("./src/build-config.json", import.meta.url).pathname).text();
  _buildCfg = JSON.parse(raw) as { posthog_key?: string; api_host?: string; crisp_website_id?: string; crisp_history_endpoint?: string; crisp_history_secret?: string; cal_url?: string };
} catch { /* no build-config.json — OSS build */ }

const isDev               = process.argv.includes("dev");
const _phKey              = JSON.stringify(isDev ? "" : (_buildCfg.posthog_key        ?? ""));
const _phHost             = JSON.stringify(_buildCfg.api_host                         ?? "https://us.i.posthog.com");
const _crispId            = JSON.stringify(_buildCfg.crisp_website_id                 ?? "");
const _crispHistoryUrl    = JSON.stringify(_buildCfg.crisp_history_endpoint           ?? "");
const _crispHistorySecret = JSON.stringify(_buildCfg.crisp_history_secret             ?? "");
const _calUrl             = JSON.stringify(_buildCfg.cal_url                          ?? "");

export default {
  app: {
    name: "Draft",
    identifier: "us.draftai.draft-desktop",
    version: "0.4.3",
  },
  release: {
    baseUrl: "https://github.com/idodekerobo/draft/releases/latest/download",
    generatePatch: false,
  },
  runtime: {
    exitOnLastWindowClosed: false,
  },
  build: {
    bun: {
      entrypoint: "src/index.ts",
      define: {
        "process.env.DRAFT_PH_KEY":           _phKey,
        "process.env.DRAFT_PH_HOST":          _phHost,
        "process.env.DRAFT_CRISP_WEBSITE_ID":       _crispId,
        "process.env.DRAFT_CRISP_HISTORY_ENDPOINT": _crispHistoryUrl,
        "process.env.DRAFT_CRISP_HISTORY_SECRET":   _crispHistorySecret,
        "process.env.DRAFT_CAL_URL":                _calUrl,
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
