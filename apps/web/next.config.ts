import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  // Workspace packages ship TypeScript source, so Next compiles them.
  transpilePackages: ["draft-shared-ui", "draft-core"],
};

export default nextConfig;
