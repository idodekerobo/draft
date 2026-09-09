const FIREFLIES_GRAPHQL_URL = "https://api.fireflies.ai/graphql";

const TRANSCRIPT_QUERY = `
  query Transcript($meetingId: String!) {
    transcript(id: $meetingId) {
      id
      title
      date
      participants
      meeting_attendees {
        displayName
        name
        email
      }
      summary {
        short_summary
        overview
        action_items
        outline
      }
      sentences {
        speaker_name
        text
      }
    }
  }
`;

interface FirefliesGraphQLAttendee {
  displayName?: string | null;
  name?: string | null;
  email?: string | null;
}

interface FirefliesGraphQLSummary {
  short_summary?: string | null;
  overview?: string | null;
  action_items?: string | null;
  outline?: string | null;
}

interface FirefliesGraphQLSentence {
  speaker_name?: string | null;
  text?: string | null;
}

interface FirefliesGraphQLTranscript {
  id: string;
  title: string;
  date: number | string;
  participants?: string[] | null;
  meeting_attendees?: FirefliesGraphQLAttendee[] | null;
  summary?: FirefliesGraphQLSummary | null;
  sentences?: FirefliesGraphQLSentence[] | null;
}

interface FirefliesGraphQLResponse {
  data?: { transcript: FirefliesGraphQLTranscript | null };
  errors?: { message: string }[];
}

export interface FirefliesMeetingData {
  meetingId: string;
  title: string;
  occurredAt: string; // ISO
  attendees: string[];
  shortSummary?: string;
  overview?: string;
  actionItems?: string;
  outline?: string;
  sentences: { speakerName: string; text: string }[];
}

function toIsoDate(date: number | string): string {
  if (typeof date === "number") {
    return new Date(date).toISOString();
  }
  const parsedNumeric = Number(date);
  if (!Number.isNaN(parsedNumeric) && date.trim() !== "") {
    return new Date(parsedNumeric).toISOString();
  }
  return new Date(date).toISOString();
}

const USER_QUERY = `
  query CurrentUser {
    user {
      user_id
      name
      email
    }
  }
`;

interface FirefliesGraphQLUser {
  user_id?: string | null;
  name?: string | null;
  email?: string | null;
}

interface FirefliesUserGraphQLResponse {
  data?: { user: FirefliesGraphQLUser | null };
  errors?: { message: string }[];
}

export interface FirefliesAccountIdentity {
  externalAccountId: string;
  displayName: string | null;
}

// Verified against the Fireflies GraphQL API: `user` returns the token's own
// account -- there is no separate "whoami"/introspection endpoint.
export async function fetchFirefliesAccountIdentity(apiToken: string): Promise<FirefliesAccountIdentity> {
  const response = await fetch(FIREFLIES_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiToken}`,
    },
    body: JSON.stringify({ query: USER_QUERY }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Fireflies API request failed for account identity: ${response.status} ${response.statusText} ${body}`);
  }

  const payload = (await response.json()) as FirefliesUserGraphQLResponse;
  if (payload.errors && payload.errors.length > 0) {
    throw new Error(`Fireflies API returned errors for account identity: ${payload.errors.map((e) => e.message).join("; ")}`);
  }

  const user = payload.data?.user;
  const externalAccountId = user?.user_id || user?.email;
  if (!externalAccountId) {
    throw new Error("Fireflies API returned no account identity for this token");
  }

  return {
    externalAccountId,
    displayName: user?.name || user?.email || null,
  };
}

export async function fetchFirefliesMeeting(
  apiToken: string,
  meetingId: string,
): Promise<FirefliesMeetingData> {
  const response = await fetch(FIREFLIES_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiToken}`,
    },
    body: JSON.stringify({
      query: TRANSCRIPT_QUERY,
      variables: { meetingId },
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Fireflies API request failed for transcript ${meetingId}: ${response.status} ${response.statusText} ${body}`,
    );
  }

  const payload = (await response.json()) as FirefliesGraphQLResponse;

  if (payload.errors && payload.errors.length > 0) {
    throw new Error(
      `Fireflies API returned errors for transcript ${meetingId}: ${payload.errors
        .map((e) => e.message)
        .join("; ")}`,
    );
  }

  const transcript = payload.data?.transcript;
  if (!transcript) {
    throw new Error(`Fireflies API returned no transcript for id ${meetingId}`);
  }

  const attendeesFromAttendeeList = (transcript.meeting_attendees ?? [])
    .map((a) => a.displayName || a.name || a.email)
    .filter((v): v is string => Boolean(v));
  const attendees =
    attendeesFromAttendeeList.length > 0
      ? attendeesFromAttendeeList
      : (transcript.participants ?? []).filter((v): v is string => Boolean(v));

  const sentences = (transcript.sentences ?? []).map((s) => ({
    speakerName: s.speaker_name ?? "Unknown speaker",
    text: s.text ?? "",
  }));

  return {
    meetingId: transcript.id ?? meetingId,
    title: transcript.title ?? "Untitled meeting",
    occurredAt: toIsoDate(transcript.date),
    attendees,
    shortSummary: transcript.summary?.short_summary ?? undefined,
    overview: transcript.summary?.overview ?? undefined,
    actionItems: transcript.summary?.action_items ?? undefined,
    outline: transcript.summary?.outline ?? undefined,
    sentences,
  };
}
