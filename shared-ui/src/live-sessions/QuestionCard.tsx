"use client";

import { useId, useState } from "react";
import { closedMessage } from "./approval-result";
import type { OpenApproval } from "./stream-items";
import type { AnswerValue, ApprovalResult, LiveQuestion } from "./types";

type Phase = { name: "idle" } | { name: "sending" } | { name: "sent" } | { name: "closed"; message: string } | { name: "failed" };

/** What a person picked for one question. `other` is typed text; `picked` holds option labels. */
interface Choice {
  picked: string[];
  otherOn: boolean;
  other: string;
}

const EMPTY: Choice = { picked: [], otherOn: false, other: "" };

/** The answer for one question, or null while it is incomplete. */
export function answerFor(question: LiveQuestion, choice: Choice): AnswerValue | null {
  const typed = choice.otherOn ? choice.other.trim() : "";
  if (choice.otherOn && !typed) return null;
  const values = [...choice.picked, ...(typed ? [typed] : [])];
  if (values.length === 0) return null;
  return question.multiSelect ? values : values[0]!;
}

/** All answers by question key, or null while any question is open. */
export function collectAnswers(questions: LiveQuestion[], choices: Record<string, Choice>): Record<string, AnswerValue> | null {
  const answers: Record<string, AnswerValue> = {};
  for (const question of questions) {
    const answer = answerFor(question, choices[question.key] ?? EMPTY);
    if (answer === null) return null;
    answers[question.key] = answer;
  }
  return answers;
}

/** Claude's questions as a form. Anyone on the team can answer; the first answer wins. */
export function QuestionCard({
  approval,
  hostName,
  onAnswer,
}: {
  approval: OpenApproval;
  hostName: string | null;
  onAnswer(requestId: string, answers: Record<string, AnswerValue>): Promise<ApprovalResult>;
}) {
  const id = useId();
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [phase, setPhase] = useState<Phase>({ name: "idle" });
  const answers = collectAnswers(approval.questions, choices);
  const busy = phase.name === "sending" || phase.name === "sent";

  const update = (key: string, change: (current: Choice) => Choice) => setChoices((all) => ({ ...all, [key]: change(all[key] ?? EMPTY) }));

  async function submit() {
    if (!answers) return;
    setPhase({ name: "sending" });
    try {
      const result = await onAnswer(approval.requestId, answers);
      if (result.ok) setPhase({ name: "sent" });
      else if (result.error === "failed") setPhase({ name: "failed" });
      else setPhase({ name: "closed", message: closedMessage(result) });
    } catch {
      setPhase({ name: "failed" });
    }
  }

  return (
    <section className="ui-approval ui-question" role="group" aria-label="Question from Claude">
      <div className="ui-approval__head">
        <h2 className="ui-approval__title">Claude has a question</h2>
        <p className="ui-muted ui-approval__where">You can also answer in the terminal on {hostName ?? "the owner's computer"}.</p>
      </div>
      {approval.questions.map((question, index) => {
        const choice = choices[question.key] ?? EMPTY;
        const name = `${id}-${index}`;
        const type = question.multiSelect ? "checkbox" : "radio";
        return (
          <fieldset key={question.key} className="ui-question__item" disabled={busy}>
            <legend className="ui-question__legend">
              {question.header && <span className="ui-question__header">{question.header}</span>}
              <span>{question.question}</span>
            </legend>
            {question.options.map((option) => (
              <label key={option.label} className="ui-question__option">
                <input
                  type={type}
                  name={name}
                  checked={choice.picked.includes(option.label)}
                  onChange={(e) =>
                    update(question.key, (c) => ({
                      ...c,
                      picked: question.multiSelect ? (e.target.checked ? [...c.picked, option.label] : c.picked.filter((l) => l !== option.label)) : [option.label],
                      otherOn: question.multiSelect ? c.otherOn : false,
                    }))
                  }
                />
                <span className="ui-question__label">
                  <span>{option.label}</span>
                  {option.description && <span className="ui-question__desc">{option.description}</span>}
                </span>
              </label>
            ))}
            {question.isOther && (
              <>
                <label className="ui-question__option">
                  <input
                    type={type}
                    name={name}
                    checked={choice.otherOn}
                    onChange={(e) => update(question.key, (c) => ({ ...c, otherOn: e.target.checked, picked: question.multiSelect ? c.picked : [] }))}
                  />
                  <span className="ui-question__label">Other</span>
                </label>
                {choice.otherOn && (
                  <input
                    className="ui-input ui-question__other"
                    type={question.isSecret ? "password" : "text"}
                    aria-label={`Your answer to: ${question.question}`}
                    value={choice.other}
                    autoFocus
                    onChange={(e) => update(question.key, (c) => ({ ...c, other: e.target.value }))}
                  />
                )}
              </>
            )}
          </fieldset>
        );
      })}
      {phase.name === "closed" ? (
        <p className="ui-approval__status" role="status">{phase.message}</p>
      ) : (
        <div className="ui-approval__actions">
          <button type="button" className="ui-btn ui-btn--primary" disabled={busy || !answers} onClick={() => void submit()}>
            {phase.name === "sending" ? "Sending…" : "Send answer"}
          </button>
          {phase.name === "sent" && <span className="ui-muted ui-approval__status" role="status">Sent. Waiting for {hostName ?? "the owner's computer"}…</span>}
          {phase.name === "failed" && <span className="ui-error ui-approval__status" role="alert">Could not send. Try again.</span>}
        </div>
      )}
    </section>
  );
}
