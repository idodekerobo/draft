import { auth } from "./better-auth";
import { loadConfig } from "../config";

const config = loadConfig();

/**
 * GET /oauth2/consent-redirect?accept=&oauth_query= — a top-level-navigation
 * front for Better Auth's POST-only /oauth2/consent. The consent page can't
 * reach that endpoint via a background fetch: a cross-origin fetch strips
 * third-party cookies (same issue as the Supabase bridge), so the session
 * cookie proving who's consenting would never arrive. Calling auth.api
 * directly here runs entirely server-side using the cookie header from this
 * same-origin navigation, then forwards the resulting redirect_uri.
 */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const accept = url.searchParams.get("accept") === "true";
  const oauthQuery = url.searchParams.get("oauth_query");
  const errorRedirect = `${config.appUrl}/oauth/consent?error=1`;
  if (!oauthQuery) return Response.redirect(errorRedirect, 302);

  const cookie = req.headers.get("cookie");
  const headers = cookie ? new Headers({ cookie }) : undefined;

  try {
    const result = (await auth.api.oauth2Consent({
      body: { accept, oauth_query: oauthQuery },
      headers,
    })) as { redirect_uri?: string };
    if (!result.redirect_uri) return Response.redirect(errorRedirect, 302);
    return Response.redirect(result.redirect_uri, 302);
  } catch (error) {
    console.error("oauth-consent-redirect: consent failed", error);
    return Response.redirect(errorRedirect, 302);
  }
}
