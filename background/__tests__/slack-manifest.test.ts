import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

describe("Slack app manifest", () => {
  it("requests scopes for channel discovery and public-channel auto-join", () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dir, "../integrations/slack/manifest.json"), "utf8"),
    ) as { oauth_config?: { scopes?: { bot?: unknown } } };
    const botScopes = manifest.oauth_config?.scopes?.bot;

    expect(botScopes).toEqual(expect.arrayContaining([
      "channels:read",
      "channels:join",
      "groups:read",
      "im:read",
      "mpim:read",
    ]));
  });
});
