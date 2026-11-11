export interface SlackDirectoryUser {
  id: string;
  name: string;
  email: string | null;
}

export type SlackUsersResult = { users: SlackDirectoryUser[]; sawPeopleWithoutEmail: boolean };

interface RawSlackUser {
  id?: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  is_app_user?: boolean;
  is_restricted?: boolean;
  is_ultra_restricted?: boolean;
  profile?: { email?: string; real_name?: string; display_name?: string };
}

/**
 * Lists the full members of a Slack workspace. Bots, deleted users and guests are left out: guests are often clients.
 * `sawPeopleWithoutEmail` is true when members came back with no email at all, which means the app lacks `users:read.email`.
 */
export async function fetchSlackUsers(botToken: string, fetchFn: typeof fetch = fetch): Promise<SlackUsersResult> {
  const users: SlackDirectoryUser[] = [];
  let withoutEmail = 0;
  let cursor = "";
  for (let page = 0; page < 100; page += 1) {
    const query = new URLSearchParams({ limit: "200" });
    if (cursor) query.set("cursor", cursor);
    const response = await fetchFn(`https://slack.com/api/users.list?${query.toString()}`, { headers: { Authorization: `Bearer ${botToken}` } });
    if (!response.ok) throw new Error(`slack_users_list_failed: HTTP ${response.status}`);
    const body = (await response.json()) as { ok?: boolean; error?: string; members?: RawSlackUser[]; response_metadata?: { next_cursor?: string } };
    if (!body.ok) throw new Error(`slack_users_list_failed: ${body.error ?? "unknown"}`);

    for (const member of body.members ?? []) {
      if (!member.id || member.id === "USLACKBOT" || member.deleted || member.is_bot || member.is_app_user) continue;
      if (member.is_restricted || member.is_ultra_restricted) continue;
      const email = member.profile?.email?.trim() || null;
      if (!email) withoutEmail += 1;
      users.push({ id: member.id, name: member.profile?.real_name || member.real_name || member.profile?.display_name || member.name || member.id, email });
    }
    cursor = body.response_metadata?.next_cursor ?? "";
    if (!cursor) break;
  }
  return { users, sawPeopleWithoutEmail: users.length > 0 && withoutEmail === users.length };
}
