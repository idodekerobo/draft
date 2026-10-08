import type { NextConfig } from "next";

const SOCIAL_LANDING = "/getstarted?utm_medium=organic_social&utm_campaign=caption&utm_source=";

const nextConfig: NextConfig = {
  reactCompiler: true,
  async redirects() {
    return [
      { source: "/tt", destination: `${SOCIAL_LANDING}tiktok`, permanent: false },
      { source: "/ig", destination: `${SOCIAL_LANDING}instagram`, permanent: false },
    ];
  },
};

export default nextConfig;
