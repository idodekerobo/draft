import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "Draft",
    identifier: "us.draftai.draft-desktop",
    version: "0.0.1",
  },
  build: {
    bun: {
      entrypoint: "src/index.ts",
    },
    views: {
      mainview: {
        entrypoint: "src/app/index.ts",
      },
    },
    copy: {
      "src/app/index.html": "views/mainview/index.html",
      "src/app/index.css":  "views/mainview/index.css",
    },
    mac: {
      codesign: true,
      notarize: true,
    },
  },
} satisfies ElectrobunConfig;