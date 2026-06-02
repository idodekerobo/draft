import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "Draft",
    identifier: "us.draftai.draft-desktop",
    version: "0.0.1",
  },
  runtime: {
    exitOnLastWindowClosed: false,
  },
  build: {
    bun: {
      entrypoint: "src/index.ts",
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
      "assets/bin/draft":   "bin/draft",
    },
    mac: {
      icons: "assets/icon.iconset",
      codesign: true,
      notarize: true,
    },
  },
} satisfies ElectrobunConfig;