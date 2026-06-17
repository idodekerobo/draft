declare module "openclaw/plugin-sdk/plugin-entry" {
  interface PluginHookSessionStartEvent {
    sessionId: string;
    sessionKey?: string;
    resumedFrom?: string;
  }

  interface PluginHookSessionEndEvent {
    sessionId: string;
    sessionKey?: string;
    sessionFile?: string;
    reason?: string;
    messageCount?: number;
    durationMs?: number;
  }

  interface PluginHookSessionContext {
    agentId?: string;
    sessionId: string;
    sessionKey?: string;
  }

  interface SessionWorkflow {
    enqueueNextTurnInjection(params: { sessionKey: string; text: string }): Promise<void>;
  }

  interface SessionApi {
    workflow: SessionWorkflow;
  }

  interface OpenClawPluginApi {
    session: SessionApi;
    on(event: "resolve_exec_env", handler: () => Promise<Record<string, string>> | Record<string, string>): void;
    on(event: "session_start", handler: (event: PluginHookSessionStartEvent, ctx: PluginHookSessionContext) => Promise<void> | void): void;
    on(event: "session_end", handler: (event: PluginHookSessionEndEvent, ctx?: PluginHookSessionContext) => Promise<void> | void): void;
  }

  interface DefinePluginEntryOptions {
    id: string;
    name: string;
    description: string;
    register: (api: OpenClawPluginApi) => void;
  }

  interface DefinedPluginEntry {}

  export function definePluginEntry(options: DefinePluginEntryOptions): DefinedPluginEntry;
}
