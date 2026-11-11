import { ROUTINE_EVENTS, type AgentRoutineConfig } from "../routines/config";

/** The task of the meeting follow-up routine. The meeting itself reaches the run as event content. */
export const MEETING_FOLLOW_UP_PROMPT = `A meeting just ended. Its notes are in the event content above.

Find everyone who owns an action item. For each owner:
1. Call people.find with their name.
2. If exactly one active teammate matches, call people.notify with that person's id and a short message listing only THEIR items, one line each, with the due date when the notes give one.
3. If nobody matches, more than one person matches, or the match is pending, do not message anyone for that owner.

Never put one person's items in another person's message. Do not message anyone who owns no item. Do not write to the company context.

Your final reply says who you messaged, and who you could not message and why.`;

/** The routine as it is saved: it listens for summarized meetings and may message teammates. */
export const meetingFollowUpRoutine = (harness: AgentRoutineConfig["harness"] = "claude"): AgentRoutineConfig => ({
  title: "Meeting follow-up",
  prompt: MEETING_FOLLOW_UP_PROMPT,
  harness,
  model: null,
  events: [ROUTINE_EVENTS[0]],
  canNotify: true,
});
