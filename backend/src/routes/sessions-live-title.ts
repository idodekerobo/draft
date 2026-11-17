import { serviceClient } from "../db/client";

type TitleRequest = Bun.BunRequest<"/live-session-titles/:sessionId">;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Public on purpose: a link preview bot cannot sign in. It returns the title and nothing else,
 * and the session id in the link is the only key.
 */
export async function TITLE(req: TitleRequest): Promise<Response> {
  const { sessionId } = req.params;
  if (!UUID.test(sessionId)) return Response.json({ title: null });

  const { data, error } = await serviceClient
    .from("sessions")
    .select("title")
    .eq("id", sessionId)
    .eq("session_type", "interactive")
    .maybeSingle<{ title: string | null }>();
  if (error) return Response.json({ error: "title_lookup_failed" }, { status: 500 });
  return Response.json({ title: data?.title ?? null });
}
