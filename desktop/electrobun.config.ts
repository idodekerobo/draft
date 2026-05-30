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
        entrypoint: "src/mainview/index.ts",
      },
    },
    copy: {
      "src/mainview/index.html": "views/mainview/index.html",
      "src/mainview/index.css":  "views/mainview/index.css",
    },
    mac: {
      codesign: true,
      notarize: true,
    },
  },
} satisfies ElectrobunConfig;