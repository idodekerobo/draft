import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { UserIdentity } from "../../rpc/schema";
import { events, rpc } from "../rpc";

const NOT_SIGNED_IN: UserIdentity = {
  signedIn: false,
  organizationId: null,
  teamId: null,
  workspaceId: null,
};

const UserIdentityContext = createContext<UserIdentity>(NOT_SIGNED_IN);

export function UserIdentityProvider({ children }: { children: ReactNode }) {
  const [identity, setIdentity] = useState<UserIdentity>(NOT_SIGNED_IN);

  useEffect(() => {
    const refresh = async () => setIdentity(await rpc.request.getUserIdentity());
    void refresh();
    const unsubscribeSignIn = events.on("signInProgress", (data) => {
      if (data.phase === "complete") void refresh();
    });
    const unsubscribeAuth = events.on("authStateChanged", ({ signedIn }) => {
      if (!signedIn) setIdentity(NOT_SIGNED_IN);
      else void refresh();
    });
    return () => {
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
