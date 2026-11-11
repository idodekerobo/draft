const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

export interface LinearDirectoryUser {
  id: string;
  name: string;
  email: string;
}

const USERS_QUERY = `
  query Users($after: String) {
    users(first: 100, after: $after) {
      nodes { id name displayName email active guest }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

interface UsersPayload {
  data?: { users?: { nodes?: Array<{ id: string; name?: string; displayName?: string; email?: string; active?: boolean; guest?: boolean }>; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } };
  errors?: unknown;
}

/** Lists the active, non-guest users of a Linear organization. */
export async function fetchLinearUsers(apiToken: string, fetchFn: typeof fetch = fetch): Promise<LinearDirectoryUser[]> {
  const users: LinearDirectoryUser[] = [];
  let after: string | null = null;
  for (let page = 0; page < 50; page += 1) {
    const response = await fetchFn(LINEAR_GRAPHQL_URL, {
      method: "POST",
      // Personal API keys are not prefixed with "Bearer ".
      headers: { "Content-Type": "application/json", Authorization: apiToken },
      body: JSON.stringify({ query: USERS_QUERY, variables: { after } }),
    });
    if (!response.ok) throw new Error(`linear_users_failed: HTTP ${response.status}`);
    const payload = (await response.json()) as UsersPayload;
    if (payload.errors || !payload.data?.users) throw new Error("linear_users_failed: bad response");

    for (const node of payload.data.users.nodes ?? []) {
      if (!node.email || node.active === false || node.guest) continue;
      users.push({ id: node.id, name: node.displayName || node.name || node.email, email: node.email });
    }
    const info = payload.data.users.pageInfo;
    if (!info?.hasNextPage || !info.endCursor) break;
    after = info.endCursor;
  }
  return users;
}
