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
    mac: {
      codesign: true,
      notarize: true,
    },
  },
} satisfies ElectrobunConfig;