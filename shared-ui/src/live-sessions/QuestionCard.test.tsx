import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QuestionCard, answerFor, collectAnswers } from "./QuestionCard";
import type { OpenApproval } from "./stream-items";
import type { ApprovalResult, LiveQuestion } from "./types";

afterEach(cleanup);

const colors: LiveQuestion = { key: "Pick colors", header: "Color", question: "Pick colors", multiSelect: true, isOther: true, isSecret: false, options: [{ label: "Red", description: "warm" }, { label: "Blue" }] };
const size: LiveQuestion = { key: "Pick a size", question: "Pick a size", multiSelect: false, isOther: true, isSecret: false, options: [{ label: "S" }, { label: "L" }] };

const approval = (questions: LiveQuestion[]): OpenApproval => ({
  type: "approval", seq: 1, requestId: "r1", kind: "question", tool: "AskUserQuestion", summary: "", input: {}, questions, plan: null, allowSession: false, permissionMode: null, resolved: null,
});

function renderCard(questions: LiveQuestion[], result: ApprovalResult = { ok: true }) {
  const onAnswer = mock(async (_id: string, _answers: Record<string, string | string[]>) => result);
  render(<QuestionCard approval={approval(questions)} hostName="Maya's MacBook" onAnswer={onAnswer} />);
  return onAnswer;
}

const send = () => screen.getByRole("button", { name: /Send answer|Sending/ }) as HTMLButtonElement;

describe("answerFor and collectAnswers", () => {
  it("a single question gives a string, a multi one a list, and typed text joins the picks", () => {
    expect(answerFor(size, { picked: ["L"], otherOn: false, other: "" })).toBe("L");
    expect(answerFor(colors, { picked: ["Red"], otherOn: true, other: " Teal " })).toEqual(["Red", "Teal"]);
    expect(answerFor(size, { picked: [], otherOn: true, other: "Huge" })).toBe("Huge");
  });

  it("is incomplete with nothing picked or with an empty Other", () => {
    expect(answerFor(size, { picked: [], otherOn: false, other: "" })).toBeNull();
    expect(answerFor(size, { picked: [], otherOn: true, other: "  " })).toBeNull();
    expect(collectAnswers([size, colors], { "Pick a size": { picked: ["S"], otherOn: false, other: "" } })).toBeNull();
  });
});

describe("QuestionCard", () => {
  it("shows each question with its options and where the owner can also answer", () => {
    renderCard([colors, size]);
    expect(screen.getByRole("group", { name: "Question from Claude" })).toBeTruthy();
    expect(screen.getByText("Pick colors")).toBeTruthy();
    expect(screen.getByText("warm")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "L" })).toBeTruthy();
    expect(screen.getAllByRole("checkbox").length).toBe(3);
    expect(screen.getByText(/answer in the terminal on Maya's MacBook/)).toBeTruthy();
  });

  it("keeps Send answer off until every question has an answer", () => {
    renderCard([colors, size]);
    expect(send().disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /^Red/ }));
    expect(send().disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "L" }));
    expect(send().disabled).toBe(false);
  });

  it("sends picks, several for a multi question, and then waits for the host", async () => {
    const onAnswer = renderCard([colors, size]);
    fireEvent.click(screen.getByRole("checkbox", { name: /^Red/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Blue" }));
    fireEvent.click(screen.getByRole("radio", { name: "S" }));
    fireEvent.click(screen.getByRole("radio", { name: "L" }));
    fireEvent.click(send());
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith("r1", { "0": ["Red", "Blue"], "1": "L" }));
    await screen.findByText(/Waiting for Maya's MacBook/);
    expect(send().disabled).toBe(true);
  });

  it("sends typed text from Other, and choosing Other clears a single pick", async () => {
    const onAnswer = renderCard([size]);
    fireEvent.click(screen.getByRole("radio", { name: "S" }));
    fireEvent.click(screen.getByRole("radio", { name: "Other" }));
    expect(send().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Your answer to: Pick a size"), { target: { value: "Huge" } });
    fireEvent.click(send());
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith("r1", { "0": "Huge" }));
  });

  it("hides a secret answer while it is typed", () => {
    renderCard([{ ...size, isSecret: true }]);
    fireEvent.click(screen.getByRole("radio", { name: "Other" }));
    expect((screen.getByLabelText("Your answer to: Pick a size") as HTMLInputElement).type).toBe("password");
  });

  it("a late answerer sees who answered first and loses the button", async () => {
    renderCard([size], { ok: false, error: "already_decided", byName: "Dev" });
    fireEvent.click(screen.getByRole("radio", { name: "S" }));
    fireEvent.click(send());
    await screen.findByText("Already decided by Dev");
    expect(screen.queryByRole("button", { name: "Send answer" })).toBeNull();
  });

  it("keeps the form and shows an error when sending fails", async () => {
    renderCard([size], { ok: false, error: "failed" });
    fireEvent.click(screen.getByRole("radio", { name: "S" }));
    fireEvent.click(send());
    await screen.findByText("Could not send. Try again.");
    expect(send().disabled).toBe(false);
  });

  it("types the Other answer into a wrapping text area inside the card", () => {
    renderCard([size]);
    const container = document.body;
    fireEvent.click(screen.getByRole("radio", { name: "Other" }));
    const field = screen.getByLabelText(/Your answer to/);
    expect(field.tagName).toBe("TEXTAREA");
    expect(container.querySelector(".ui-question__item")?.contains(field)).toBe(true);
    fireEvent.change(field, { target: { value: "one\ntwo" } });
    expect((field as HTMLTextAreaElement).value).toBe("one\ntwo");
  });

  it("shows the header on its own line, apart from the question text", () => {
    renderCard([colors]);
    const container = document.body;
    expect(container.querySelector(".ui-question__header")?.textContent).toBe("Color");
    expect(container.querySelector(".ui-question__text")?.textContent).toBe("Pick colors");
  });

  it("names the agent and drops the terminal hint for a harness with no terminal", () => {
    render(<QuestionCard approval={approval([size])} hostName="Maya's MacBook" agent="Codex" hasTerminal={false} onAnswer={async () => ({ ok: true })} />);
    expect(screen.getByText("Codex has a question")).toBeTruthy();
    expect(screen.queryByText(/answer in the terminal/)).toBeNull();
    expect(screen.getByRole("group", { name: "Question from Codex" })).toBeTruthy();
  });
});
