import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FirstUserFlow, type AgentsStepContent } from "./first-user";

afterEach(cleanup);

const agentsStep: AgentsStepContent = {
  subtitle: "Invite a teammate into your session.",
  video: { src: "/demo.mp4", poster: "/poster.jpg", alt: "Two teammates in one session" },
};

function renderFlow(overrides: Partial<Parameters<typeof FirstUserFlow>[0]> = {}) {
  const track = mock(() => {});
  const onFinish = mock(() => {});
  render(
    <FirstUserFlow
      toolList={<div>tools</div>}
      hasSource
      readingSources={[]}
      entries={[]}
      inviteUrl="https://app.test/invite/abc"
      agentPrompt="prompt"
      agentsStep={agentsStep}
      track={track}
      onFinish={onFinish}
      {...overrides}
    />,
  );
  return { track, onFinish };
}

const heading = (name: string) => screen.getByRole("heading", { level: 1, name });
const press = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

describe("FirstUserFlow steps", () => {
  it("goes sources, agents, routines, then reading when a source is connected", () => {
    renderFlow();
    expect(heading("Give Draft something to read")).toBeTruthy();
    press("Next");
    expect(heading("Code with your whole team in one agent session.")).toBeTruthy();
    press("Continue");
    expect(heading("Draft keeps your brain fresh for you.")).toBeTruthy();
    press("Continue");
    expect(heading("Draft is reading")).toBeTruthy();
  });

  it("takes the same steps after Skip and ends on the set-up screen without finishing", () => {
    const { track, onFinish } = renderFlow();
    press("Skip");
    expect(track).toHaveBeenCalledWith("onboarding_skipped", { step: "give_source" });
    expect(heading("Code with your whole team in one agent session.")).toBeTruthy();
    press("Continue");
    expect(heading("Draft keeps your brain fresh for you.")).toBeTruthy();
    press("Continue");
    expect(heading("You're set up.")).toBeTruthy();
    expect(onFinish).not.toHaveBeenCalled();
  });

  it("finishes from the set-up screen", () => {
    const { onFinish } = renderFlow();
    press("Skip");
    press("Continue");
    press("Continue");
    press("Open Draft");
    expect(onFinish).toHaveBeenCalledWith("context");
  });

  it("leaves the agents step out when the host gives none", () => {
    renderFlow({ agentsStep: undefined });
    press("Next");
    expect(heading("Draft keeps your brain fresh for you.")).toBeTruthy();
  });

  it("no longer offers Browse all tools", () => {
    renderFlow();
    expect(screen.queryByText("Browse all tools")).toBeNull();
  });

  it("lets the host replace Continue on the agents step", () => {
    renderFlow({
      agentsStep: {
        ...agentsStep,
        actions: (onContinue) => (
          <>
            <a href="/download">Download for Mac</a>
            <button type="button" onClick={onContinue}>Maybe later</button>
          </>
        ),
      },
    });
    press("Next");
    expect(screen.getByRole("link", { name: "Download for Mac" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    press("Maybe later");
    expect(heading("Draft keeps your brain fresh for you.")).toBeTruthy();
  });

  it("shows the demo as a silent loop with its poster", () => {
    renderFlow();
    press("Next");
    const video = screen.getByLabelText("Two teammates in one session") as HTMLVideoElement;
    expect(video.tagName).toBe("VIDEO");
    expect(video.muted).toBe(true);
    expect(video.loop).toBe(true);
    expect(video.getAttribute("poster")).toBe("/poster.jpg");
    expect(video.querySelector("source")?.getAttribute("src")).toBe("/demo.mp4");
  });
});
