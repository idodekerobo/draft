import { auth } from "./better-auth";

/** Handles every path under Better Auth's default "/api/auth" basePath — mounted via a Bun.serve wildcard route ("/api/auth/*"). */
export const AUTH_HANDLER = (req: Request) => auth.handler(req);

/** Serves RFC 9728/8414 discovery docs at root; Better Auth's router matches the full path regardless of how it was mounted. */
export const WELL_KNOWN_HANDLER = (req: Request) => auth.handler(req);
