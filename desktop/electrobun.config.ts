import type { ElectrobunConfig } from "electrobun";

// Read PostHog key + host from build-config.json at config evaluation time.
// Absent for OSS builds → empty string → phTrack no-ops in the main process.
let _buildCfg: { posthog_key?: string; api_host?: string; crisp_website_id?: string; crisp_history_endpoint?: string; crisp_history_secret?: string; cal_url?: string; github_oauth_client_id?: string; github_join_enabled?: boolean; draft_api_base_url?: string; draft_app_url?: string; supabase_url?: string; supabase_publishable_key?: string } = {};
try {
  const raw = await Bun.file(new URL("./src/build-config.json", import.meta.url).pathname).text();
  _buildCfg = JSON.parse(raw) as { posthog_key?: string; api_host?: string; crisp_website_id?: string; crisp_history_endpoint?: string; crisp_history_secret?: string; cal_url?: string; github_oauth_client_id?: string; github_join_enabled?: boolean; draft_api_base_url?: string; draft_app_url?: string; supabase_url?: string; supabase_publishable_key?: string };
} catch { /* no build-config.json — OSS build */ }

const isDev               = process.argv.includes("dev");
const _phKey              = JSON.stringify(isDev ? "" : (_buildCfg.posthog_key        ?? ""));
const _phHost             = JSON.stringify(_buildCfg.api_host                         ?? "https://us.i.posthog.com");
const _crispId            = JSON.stringify(_buildCfg.crisp_website_id                 ?? "");
const _crispHistoryUrl    = JSON.stringify(_buildCfg.crisp_history_endpoint           ?? "");
const _crispHistorySecret = JSON.stringify(_buildCfg.crisp_history_secret             ?? "");
const _calUrl             = JSON.stringify(_buildCfg.cal_url                          ?? "");
const _ghClientId         = JSON.stringify(_buildCfg.github_oauth_client_id           ?? "");
const _ghJoinEnabled      = JSON.stringify(_buildCfg.github_join_enabled              ?? false);
// `make run-local` supplies the root .env.local values for desktop dev. Keep
// release builds tied to build-config.json so local URLs cannot accidentally
// be baked into a distributable bundle.
const _draftApiBaseUrl    = JSON.stringify(isDev ? (process.env.DRAFT_API_BASE_URL ?? _buildCfg.draft_api_base_url) : (_buildCfg.draft_api_base_url ?? "https://api.draftai.us"));
const _draftAppUrl        = JSON.stringify(isDev ? (process.env.DRAFT_APP_URL ?? _buildCfg.draft_app_url) : (_buildCfg.draft_app_url ?? "https://app.draftai.us"));
const _supabaseUrl        = JSON.stringify(isDev ? (process.env.DRAFT_SUPABASE_URL ?? _buildCfg.supabase_url) : (_buildCfg.supabase_url ?? "http://localhost:54321"));
const _supabasePublishableKey = JSON.stringify(isDev ? (process.env.DRAFT_SUPABASE_PUBLISHABLE_KEY ?? _buildCfg.supabase_publishable_key) : (_buildCfg.supabase_publishable_key ?? ""));

export default {
  app: {
    name: "Draft",
    identifier: "us.draftai.draft-desktop",
    version: "0.6.2",
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
        "process.env.DRAFT_GITHUB_OAUTH_CLIENT_ID": _ghClientId,
        "process.env.DRAFT_GITHUB_JOIN_ENABLED":    _ghJoinEnabled,
        "process.env.DRAFT_API_BASE_URL":           _draftApiBaseUrl,
        "process.env.DRAFT_APP_URL":                _draftAppUrl,
        "process.env.DRAFT_SUPABASE_URL":            _supabaseUrl,
        "process.env.DRAFT_SUPABASE_PUBLISHABLE_KEY": _supabasePublishableKey,
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
    // `electrobun dev --watch` runs without generated release binaries. The
    // explicit build:dev/canary/stable commands still run postBuild after
    // prebuild.sh and package those binaries normally.
    postBuild: isDev ? "" : "scripts/postbuild.ts",
    // Fires after the outer self-extracting wrapper bundle is assembled, before
    // it is codesigned. Lowers Contents/MacOS/launcher's macOS deployment floor.
    postWrap: "scripts/postwrap.ts",
  },
} satisfies ElectrobunConfig;
