import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { UserIdentity } from "../../rpc/schema";
import { events, rpc } from "../rpc";

const NOT_SIGNED_IN: UserIdentity = {
  signedIn: false,
  hydrated: false,
  organizationId: null,
  teamId: null,
  workspaceId: null,
};
const SIGNED_OUT_HYDRATED: UserIdentity = { ...NOT_SIGNED_IN, hydrated: true };

const UserIdentityContext = createContext<UserIdentity>(NOT_SIGNED_IN);

export function UserIdentityProvider({ children }: { children: ReactNode }) {
  const [identity, setIdentity] = useState<UserIdentity>(NOT_SIGNED_IN);

  useEffect(() => {
    let live = true;
    let generation = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const delays = [1000, 2000, 5000, 10000, 30000];
    const refresh = async (attempt = 0) => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      const request = ++generation;
      try {
        const next = await rpc.request.getUserIdentity();
        if (live && request === generation) setIdentity(next);
      } catch {
        if (live && request === generation) {
          const index = Math.min(attempt, delays.length - 1);
          timer = setTimeout(() => void refresh(index + 1), delays[index]);
        }
      }
    };
    void refresh();
    const unsubscribeSignIn = events.on("signInProgress", (data) => {
      if (data.phase === "complete") void refresh();
    });
    const unsubscribeAuth = events.on("authStateChanged", ({ signedIn }) => {
      if (!signedIn) {
        generation++;
        if (timer) clearTimeout(timer);
        setIdentity(SIGNED_OUT_HYDRATED);
      }
      else void refresh();
    });
    return () => {
      live = false;
      generation++;
      if (timer) clearTimeout(timer);
      unsubscribeSignIn();
      unsubscribeAuth();
    };
  }, []);

  return (
    <UserIdentityContext.Provider value={identity}>
      {children}
    </UserIdentityContext.Provider>
  );
}

export function useUserIdentity(): UserIdentity {
  return useContext(UserIdentityContext);
}
