"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { IntegrationActions } from "../types";

const IntegrationActionsContext = createContext<IntegrationActions | null>(null);

export function IntegrationActionsProvider({ actions, children }: { actions: IntegrationActions; children: ReactNode }) {
  return <IntegrationActionsContext.Provider value={actions}>{children}</IntegrationActionsContext.Provider>;
}

export function useIntegrationActions(): IntegrationActions {
  const actions = useContext(IntegrationActionsContext);
  if (!actions) throw new Error("IntegrationActionsProvider is required");
  return actions;
}
