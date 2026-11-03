"use client";

import { useId, useRef, useState, useEffect } from "react";
import { SendStatus, useSend } from "./useSend";
import type { OpenApproval } from "./stream-items";
import type { AnswerValue, ApprovalResult, LiveQuestion } from "./types";

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

function OtherText({ label, secret, value, onChange }: { label: string; secret: boolean; value: string; onChange(value: string): void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  if (secret) return <input className="ui-question__other" type="password" aria-label={label} value={value} autoFocus onChange={(e) => onChange(e.target.value)} />;
  return <textarea ref={ref} className="ui-question__other" rows={1} aria-label={label} value={value} autoFocus onChange={(e) => onChange(e.target.value)} />;
}

/** Claude's questions as a form. Anyone on the team can answer; the first answer wins. */
export function QuestionCard({
  approval,
  hostName,
  onAnswer,
  onSkip,
  agent = "Claude",
  hasTerminal = true,
}: {
  approval: OpenApproval;
  hostName: string | null;
  onAnswer(requestId: string, answers: Record<string, AnswerValue>): Promise<ApprovalResult>;
  onSkip?(requestId: string): Promise<ApprovalResult>;
  agent?: string;
  /** Whether the question also shows in a terminal the owner can answer in. */
  hasTerminal?: boolean;
}) {
  const id = useId();
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const { phase, run, busy, sendingWhat } = useSend();
  const answers = collectAnswers(approval.questions, choices);

  const update = (key: string, change: (current: Choice) => Choice) => setChoices((all) => ({ ...all, [key]: change(all[key] ?? EMPTY) }));

  const submit = () => {
    if (!answers) return;
    const byPosition = Object.fromEntries(approval.questions.map((q, index) => [String(index), answers[q.key]!]));
    return run("answer", () => onAnswer(approval.requestId, byPosition));
  };

  return (
    <section className="ui-approval ui-question" role="group" aria-label={`Question from ${agent}`}>
      <div className="ui-approval__head">
        <h2 className="ui-approval__title">{agent} has a question</h2>
        {hasTerminal && <p className="ui-muted ui-approval__where">You can also answer in the terminal on {hostName ?? "the owner's computer"}.</p>}
      </div>
      <div className="ui-question__body">
      {approval.questions.map((question, index) => {
        const choice = choices[question.key] ?? EMPTY;
        const name = `${id}-${index}`;
        const type = question.multiSelect ? "checkbox" : "radio";
        return (
          <fieldset key={question.key} className="ui-question__item" disabled={busy}>
            <legend className="ui-question__legend">
              {question.header && <span className="ui-question__header">{question.header}</span>}
              <span className="ui-question__text">{question.question}</span>
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
                <label className="ui-question__option ui-question__option--other">
                  <input
                    type={type}
                    name={name}
                    checked={choice.otherOn}
                    onChange={(e) => update(question.key, (c) => ({ ...c, otherOn: e.target.checked, picked: question.multiSelect ? c.picked : [] }))}
                  />
                  <span className="ui-question__label">Other</span>
                </label>
                {choice.otherOn && (
                  <OtherText label={`Your answer to: ${question.question}`} secret={question.isSecret} value={choice.other} onChange={(other) => update(question.key, (c) => ({ ...c, other }))} />
                )}
              </>
            )}
          </fieldset>
        );
      })}
      </div>
      {phase.name === "closed" ? (
        <p className="ui-approval__status" role="status">{phase.message}</p>
      ) : (
        <div className="ui-approval__actions">
          <button type="button" className="ui-btn ui-btn--primary" disabled={busy || !answers} onClick={() => void submit()}>
            {sendingWhat("answer") ? "Sending…" : "Send answer"}
          </button>
          {onSkip && (
            <button type="button" className="ui-btn" disabled={busy} onClick={() => void onSkip(approval.requestId)}>
              Skip <kbd className="ui-kbd">Esc</kbd>
            </button>
          )}
          <SendStatus phase={phase} hostName={hostName} />
        </div>
      )}
    </section>
  );
}
