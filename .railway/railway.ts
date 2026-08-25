import { defineRailway, github, preserve, project, service } from "railway/iac";

export default defineRailway(() => {
  const draft = service("draft", {
    source: github("idodekerobo/draft", { checkSuites: false }),
    build: "bun install --frozen-lockfile",
    start: "bun run backend/src/server.ts",
    healthcheck: "/health",
    healthcheckTimeout: 30,
    replicas: { "us-west2": 1 },
    domains: ["api.draftai.us"],
    env: {
      DRAFT_API_BASE_URL: preserve(),
      DRAFT_APP_URL: preserve(),
      DRAFT_LANDING_URL: preserve(),
      FLY_API_TOKEN: preserve(),
      FLY_APP_NAME: preserve(),
      FLY_REGION: preserve(),
      FLY_SANDBOX_IMAGE: preserve(),
      GITHUB_APP_ID: preserve(),
      GITHUB_APP_PRIVATE_KEY: preserve(),
      GITHUB_APP_SLUG: preserve(),
      GITHUB_APP_WEBHOOK_SECRET: preserve(),
      INFERENCE_CREDENTIAL_KEK_V1: preserve(),
      SANDBOX_CALLBACK_SECRET: preserve(),
      SUPABASE_DB_PASSWORD: preserve(),
      SUPABASE_PUBLISHABLE_KEY: preserve(),
      SUPABASE_SECRET_KEY: preserve(),
      SUPABASE_URL: preserve(),
    },
  });

  return project("draft-backend", {
    resources: [draft],
  });
});
