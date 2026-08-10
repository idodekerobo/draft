import { AuthRefreshError, clearAuthState, getFreshAccessToken, readAuthState, writeAuthState, type AuthState } from "draft-core/auth-state";
import type { UserIdentity } from "../../rpc/schema";

export class TransientIdentityError extends Error {}

export interface IdentityDeps {
  read(): AuthState | null;
  write(state: AuthState): void;
  clear(): void;
  token(forceRefresh: boolean): Promise<string>;
  fetchWhoami(token: string): Promise<Response>;
}

export function defaultIdentityDeps(): IdentityDeps {
  const apiUrl = process.env.DRAFT_API_BASE_URL ?? "https://api.draftai.us";
  return {
    read: readAuthState,
    write: writeAuthState,
    clear: clearAuthState,
    token: (forceRefresh) => getFreshAccessToken({
      supabaseUrl: process.env.DRAFT_SUPABASE_URL ?? "",
      publishableKey: process.env.DRAFT_SUPABASE_PUBLISHABLE_KEY ?? "",
      forceRefresh,
    }),
    fetchWhoami: (token) => fetch(`${apiUrl}/whoami`, { headers: { Authorization: `Bearer ${token}` } }),
  };
}

const signedOut = (): UserIdentity => ({ signedIn: false, hydrated: true, organizationId: null, teamId: null, workspaceId: null, onboardingCompletedAt: null });

export async function hydrateUserIdentity(deps: IdentityDeps = defaultIdentityDeps()): Promise<UserIdentity> {
  const cached = deps.read();
  if (!cached) return signedOut();
  if (cached.identity_resolved) return { signedIn: true, hydrated: true, organizationId: cached.organization_id, teamId: cached.team_id, workspaceId: cached.workspace_id, onboardingCompletedAt: cached.onboarding_completed_at };

  let response: Response;
  try {
    let token = await deps.token(false);
    response = await deps.fetchWhoami(token);
    if (response.status === 401 || response.status === 403) {
      token = await deps.token(true);
      response = await deps.fetchWhoami(token);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "not_signed_in" || (error instanceof AuthRefreshError && error.kind === "terminal")) {
      deps.clear();
      return signedOut();
    }
    throw new TransientIdentityError(message || "identity_unavailable");
  }

  if (response.status === 401 || response.status === 403) {
    deps.clear();
    return signedOut();
  }
  if (!response.ok) throw new TransientIdentityError(`whoami_${response.status}`);
  const body = await response.json() as { organization_id?: string | null; primary_team_id?: string | null; workspace_id?: string | null; onboarding_completed_at?: string | null };
  const current = deps.read();
  // A sign-out or newer sign-in won the race while /whoami was in flight.
  if (!current || current.refresh_token !== cached.refresh_token) return hydrateUserIdentity(deps);
  const resolved: AuthState = { ...current, organization_id: body.organization_id ?? null, team_id: body.primary_team_id ?? null, workspace_id: body.workspace_id ?? null, identity_resolved: true, onboarding_completed_at: body.onboarding_completed_at ?? null };
  deps.write(resolved);
  return { signedIn: true, hydrated: true, organizationId: resolved.organization_id, teamId: resolved.team_id, workspaceId: resolved.workspace_id, onboardingCompletedAt: resolved.onboarding_completed_at };
}

export function createIdentityHydrator(deps: IdentityDeps) {
  let inFlight: Promise<UserIdentity> | null = null;
  return () => {
    if (!inFlight) inFlight = hydrateUserIdentity(deps).finally(() => { inFlight = null; });
    return inFlight;
  };
}

export const getUserIdentity = createIdentityHydrator(defaultIdentityDeps());
