"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { HeadlessSetupActions } from "../types";

const HeadlessSetupActionsContext = createContext<HeadlessSetupActions | null>(null);

export function HeadlessSetupActionsProvider({ actions, children }: { actions: HeadlessSetupActions; children: ReactNode }) {
  return <HeadlessSetupActionsContext.Provider value={actions}>{children}</HeadlessSetupActionsContext.Provider>;
}

export function useHeadlessSetupActions(): HeadlessSetupActions {
  const actions = useContext(HeadlessSetupActionsContext);
  if (!actions) throw new Error("HeadlessSetupActionsProvider is required");
  return actions;
}
