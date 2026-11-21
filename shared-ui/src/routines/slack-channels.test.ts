import { describe, expect, test } from "bun:test";
import { slackChannelsFromConnections } from "./slack-channels";

describe("slackChannelsFromConnections", () => {
  test("returns the joined channels of the Slack connection", () => {
    const channels = [{ id: "C1", name: "general" }];
    expect(slackChannelsFromConnections({ status: "ok", output: { connections: [{ status: "connected", channels }] } })).toEqual(channels);
  });

  test("says when Slack is not connected", () => {
    expect(() => slackChannelsFromConnections({ status: "ok", output: { connections: [{ status: "not_connected" }] } })).toThrow("Slack is not connected");
  });

  test("passes on why the channels could not be listed", () => {
    expect(() => slackChannelsFromConnections({ status: "ok", output: { connections: [{ status: "connected", channelsError: "Could not list Slack channels. Try again shortly." }] } })).toThrow("Could not list Slack channels");
  });

  test("uses the tool's own message when the call did not work", () => {
    expect(() => slackChannelsFromConnections({ status: "denied", message: "Not allowed to call connections.list" })).toThrow("Not allowed to call connections.list");
    expect(() => slackChannelsFromConnections({ status: "ok", output: { connections: [] } })).toThrow("Could not load Slack channels.");
  });
});
