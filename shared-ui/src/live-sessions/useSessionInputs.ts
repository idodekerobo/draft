"use client";

import { useMutation, useMutationState } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { useQueryClient } from "../query";
import { syncSessionIntoLists } from "./sessions-list";
import { sessionStreamKey, type SessionStreamData } from "./useSessionStream";
import type { ComposerInput, LiveSessionInput, LiveSessionsApi } from "./types";

export interface SessionInputsState {
  inputs: ComposerInput[];
  send(text: string): Promise<void>;
  act(inputId: string, action: "resend" | "dismiss"): Promise<void>;
}

interface SendVariables {
  localId: string;
  text: string;
  sentAt: number;
}

const sendKey = (sessionId: string) => ["live-session-send", sessionId] as const;
// Server and device clocks differ; a server copy counts as this send if it is not older than this.
const CLOCK_SLACK_MS = 60_000;
let localSeq = 0;

/** Local sends that the server list does not hold yet. A send matches one server input with the same text. */
function unmatchedSends(sends: SendVariables[], server: LiveSessionInput[]): SendVariables[] {
  const taken = new Set<string>();
  return sends.filter((send) => {
    const match = server.find((input) => input.mine && !taken.has(input.id) && input.text === send.text && Date.parse(input.created_at) >= send.sentAt - CLOCK_SLACK_MS);
    if (match) taken.add(match.id);
    return !match;
  });
}

/**
 * Sends and resends messages. The list of waiting messages comes with the stream poll.
 * A send shows as "Sending…" and moves the session to the top of the sidebar at once. It stays in the
 * mutation cache until the server list holds the message, so it survives a switch to another session.
 */
export function useSessionInputs(api: LiveSessionsApi, sessionId: string, inputs: LiveSessionInput[], refresh: () => Promise<void>): SessionInputsState {
  const client = useQueryClient();
  const mutation = useMutation({
    mutationKey: sendKey(sessionId),
    mutationFn: async ({ text }: SendVariables) => {
      await api.sendMessage(sessionId, text);
      await refresh();
    },
    onMutate: () => {
      const session = client.getQueryData<SessionStreamData>(sessionStreamKey(sessionId))?.session;
      if (!session) return undefined;
      syncSessionIntoLists(client, { ...session, last_event_at: new Date().toISOString() });
      return { session };
    },
    onError: (_error, _variables, context) => {
      if (context) syncSessionIntoLists(client, context.session, true);
    },
  });

  const sending = useMutationState({
    filters: { mutationKey: sendKey(sessionId), status: "pending" },
    select: (mutation) => mutation.state.variables as SendVariables,
  });

  const all = useMemo<ComposerInput[]>(() => {
    const local = unmatchedSends(sending, inputs).map<ComposerInput>((send) => ({
      id: send.localId,
      author_user_id: "",
      author_name: "You",
      text: send.text,
      state: "sending",
      reason: null,
      created_at: new Date(send.sentAt).toISOString(),
      updated_at: new Date(send.sentAt).toISOString(),
      mine: true,
    }));
    return [...inputs, ...local];
  }, [inputs, sending]);

  const { mutateAsync } = mutation;
  const send = useCallback((text: string) => mutateAsync({ localId: `local-${++localSeq}`, text, sentAt: Date.now() }), [mutateAsync]);

  const act = useCallback(
    async (inputId: string, action: "resend" | "dismiss") => {
      await api.actOnInput(sessionId, inputId, action);
      await refresh();
    },
    [api, sessionId, refresh],
  );

  return { inputs: all, send, act };
}
