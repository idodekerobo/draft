import { loadConfig } from "../config";

type Handler<Req extends Request = Request> = (req: Req) => Response | Promise<Response>;
const config = loadConfig();

function allowedOrigin(req: Request): string | null {
  const origin = req.headers.get("origin");
  if (!origin) return null;
  return origin === config.appUrl ? origin : null;
}
function addHeaders(response: Response, origin: string | null): Response {
  response.headers.append("Vary", "Origin");
  if (origin) response.headers.set("Access-Control-Allow-Origin", origin);
  response.headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return response;
}
export function withCors<Req extends Request = Request>(handler: Handler<Req>): Handler<Req> {
  return async (req) => {
    const origin = allowedOrigin(req);
    if (req.headers.has("origin") && !origin) return addHeaders(Response.json({ error: "origin_not_allowed" }, { status: 403 }), null);
    if (req.method === "OPTIONS") return addHeaders(new Response(null, { status: 204 }), origin);
    return addHeaders(await handler(req), origin);
  };
}
export const OPTIONS = withCors(async () => new Response(null, { status: 204 }));
