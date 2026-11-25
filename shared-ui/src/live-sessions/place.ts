import type { LiveSession } from "draft-core/live-sessions";

type Placed = Partial<Pick<LiveSession, "execution_target">>;

/** True when Draft starts a sandbox for the session: it can sleep, wake and expire. */
export const isSandboxSession = (session: Placed): boolean => session.execution_target === "sandbox";

/** True when the session runs on an already-registered host, such as the person's computer. */
export const isHostSession = (session: Placed): boolean => session.execution_target === "host";

/** True when the person sees the session as running in Draft Cloud: in a sandbox, or in Draft's backend. */
export const isDraftCloudSession = (session: Placed): boolean => session.execution_target === "sandbox" || session.execution_target === "backend";
