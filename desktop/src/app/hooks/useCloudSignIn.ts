import { useEffect, useRef, useState } from "react";
import { useUserIdentity } from "../identity/UserIdentityContext";
import { events, rpc } from "../rpc";

export type CloudSignInPhase = "idle" | "awaiting_approval" | "complete" | "error";

export function useCloudSignIn() {
  const { signedIn } = useUserIdentity();
  const [cloudSignIn, setCloudSignIn] = useState<CloudSignInPhase>(signedIn ? "complete" : "idle");
  const [cloudSignInError, setCloudSignInError] = useState<string | null>(null);
  const phaseRef = useRef(cloudSignIn);

  useEffect(() => {
    phaseRef.current = cloudSignIn;
  }, [cloudSignIn]);

  useEffect(() => {
    if (signedIn) setCloudSignIn("complete");
  }, [signedIn]);

  useEffect(() => events.on("signInProgress", ({ phase, error }) => {
    setCloudSignIn(phase);
    setCloudSignInError(error ? error.replaceAll("_", " ") : null);
  }), []);

  useEffect(() => events.on("authStateChanged", ({ signedIn: nextSignedIn }) => {
    if (!nextSignedIn) {
      setCloudSignIn("idle");
      setCloudSignInError(null);
    }
  }), []);

  useEffect(() => () => {
    if (phaseRef.current === "awaiting_approval") void rpc.request.cancelBrowserSignIn();
  }, []);

  async function handleCloudSignIn() {
    setCloudSignInError(null);
    const result = await rpc.request.startBrowserSignIn();
    if (!result.ok) {
      setCloudSignIn("error");
      setCloudSignInError(result.error ?? "Could not start sign in");
    }
  }

  async function handleCloudSignOut() {
    setCloudSignInError(null);
    const result = await rpc.request.signOut();
    if (!result.ok) {
      setCloudSignIn("error");
      setCloudSignInError(result.error ?? "Could not sign out");
    }
  }

  return { cloudSignIn, cloudSignInError, handleCloudSignIn, handleCloudSignOut };
}
