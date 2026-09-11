import { auth } from "./better-auth";
import { loadConfig } from "../config";

const config = loadConfig();

/**
 * GET /oauth2/consent-redirect?accept=&oauth_query= — a top-level-navigation
 * front for Better Auth's POST-only /oauth2/consent. The consent page can't
 * reach that endpoint via a background fetch: a cross-origin fetch strips
 * third-party cookies (same issue as the Supabase bridge), so the session
 * cookie proving who's consenting would never arrive.
 *
 * Goes through auth.handler() with a real constructed Request rather than
 * auth.api.oauth2Consent() — that internal-call shortcut leaves ctx.request
 * unset, and /oauth2/consent's re-run of the authorize logic requires it
 * (throws "request not found" otherwise).
 */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const accept = url.searchParams.get("accept") === "true";
  const oauthQuery = url.searchParams.get("oauth_query");
  const errorRedirect = `${config.appUrl}/oauth/consent?error=1`;
  if (!oauthQuery) return Response.redirect(errorRedirect, 302);

  const cookie = req.headers.get("cookie");

  try {
    const consentRequest = new Request(`${config.apiBaseUrl}/api/auth/oauth2/consent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify({ accept, oauth_query: oauthQuery }),
    });
    const response = await auth.handler(consentRequest);
    if (!response.ok) {
      console.error("oauth-consent-redirect: consent failed", response.status, await response.text());
      return Response.redirect(errorRedirect, 302);
    }
    const result = (await response.json()) as { redirect_uri?: string };
    if (!result.redirect_uri) return Response.redirect(errorRedirect, 302);
    return Response.redirect(result.redirect_uri, 302);
  } catch (error) {
    console.error("oauth-consent-redirect: consent failed", error);
    return Response.redirect(errorRedirect, 302);
  }
}
