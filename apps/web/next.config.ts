import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

const nextConfig: NextConfig = {
  reactCompiler: true,
  turbopack: { root: fileURLToPath(new URL("../../", import.meta.url)) },
  // Workspace packages ship TypeScript source, so Next compiles them.
  transpilePackages: ["draft-shared-ui", "draft-core"],
};

export default nextConfig;
