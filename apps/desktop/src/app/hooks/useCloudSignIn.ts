import { useEffect, useRef, useState } from "react";
import { useUserIdentity } from "../identity/UserIdentityContext";
import { events, rpc } from "../rpc";

export type CloudSignInPhase = "idle" | "awaiting_approval" | "complete" | "error";

export function useCloudSignIn() {
  const { signedIn, hydrated } = useUserIdentity();
  const [cloudSignIn, setCloudSignIn] = useState<CloudSignInPhase>(signedIn ? "complete" : "idle");
  const [cloudSignInError, setCloudSignInError] = useState<string | null>(null);
  const [confirmCode, setConfirmCode] = useState<string | null>(null);
  const phaseRef = useRef(cloudSignIn);

  useEffect(() => {
    phaseRef.current = cloudSignIn;
  }, [cloudSignIn]);

  useEffect(() => {
    if (hydrated && signedIn) setCloudSignIn("complete");
  }, [signedIn, hydrated]);

  useEffect(() => events.on("signInProgress", ({ phase, error, confirmCode: nextCode }) => {
    setCloudSignIn(phase);
    setCloudSignInError(error ? error.replaceAll("_", " ") : null);
    setConfirmCode(phase === "awaiting_approval" ? nextCode ?? null : null);
  }), []);

  useEffect(() => events.on("authStateChanged", ({ signedIn: nextSignedIn }) => {
    if (!nextSignedIn) {
      setCloudSignIn("idle");
      setCloudSignInError(null);
      setConfirmCode(null);
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

  return { cloudSignIn, cloudSignInError, confirmCode, handleCloudSignIn, handleCloudSignOut };
}
