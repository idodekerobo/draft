import { describe, expect, it } from "bun:test";
import { parseDeviceAuth } from "./codex-login";

const OUTPUT = `Welcome to Codex [v\u001b[90m0.165.0\u001b[0m]

Follow these steps to sign in with ChatGPT using device code authorization:

1. Open this link in your browser and sign in to your account
   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m

2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m
   \u001b[94mOQQO-6D9RS\u001b[0m
`;

describe("parseDeviceAuth", () => {
  it("finds the link and the one-time code through colour codes", () => {
    expect(parseDeviceAuth(OUTPUT)).toEqual({ url: "https://auth.openai.com/codex/device", code: "OQQO-6D9RS" });
  });

  it("waits until both the link and the code have been printed", () => {
    expect(parseDeviceAuth(OUTPUT.slice(0, OUTPUT.indexOf("2. Enter")))).toBeNull();
    expect(parseDeviceAuth("")).toBeNull();
  });
});
