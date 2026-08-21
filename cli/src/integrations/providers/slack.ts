import {
  buildSlackManifestUrl,
  listSlackChannels as fetchRawSlackChannels,
  SlackProviderError,
  validateSlackTokenFormat,
  type SlackChannel,
} from "draft-core/integrations/slack-hosted";
import {
  connectIntegration,
  listSlackChannels,
  setSlackChannels,
  type ConnectIntegrationResult,
  type FetchResult,
  type HostedSlackChannel,
  type SlackMembershipReconcileResult,
} from "../../cloud-client.ts";
import {
  CredentialInputError,
  credentialReader,
  type CredentialReader,
  type CredentialSource,
} from "../credentials.ts";
import { browserLauncher, type BrowserLauncher } from "../browser.ts";
import { ChannelSelectionInterruptedError, channelSelector, type ChannelSelector } from "../channel-select.ts";
import type { IntegrationOutput } from "../safe-output.ts";

export interface SlackConnectOptions {
  noOpen: boolean;
  source: CredentialSource;
}

export interface SlackConnectDeps {
  reader: CredentialReader;
  launcher: BrowserLauncher;
  selector: ChannelSelector;
  fetchChannels(botToken: string): Promise<HostedSlackChannel[]>;
  connect(body: { provider: "slack"; bot_token: string; app_token: string; channel_ids: string[] }): Promise<FetchResult<ConnectIntegrationResult>>;
  onSignal(signal: "SIGINT" | "SIGTERM", handler: () => void): void;
  offSignal(signal: "SIGINT" | "SIGTERM", handler: () => void): void;
}

async function defaultFetchChannels(botToken: string): Promise<HostedSlackChannel[]> {
  let channels: SlackChannel[];
  try {
    channels = await fetchRawSlackChannels(botToken);
  } catch (error) {
    throw error instanceof SlackProviderError ? error : new SlackProviderError("slack_channel_list_failed");
  }
  return channels.map((channel) => ({
    id: channel.id,
    name: channel.name,
    memberCount: channel.memberCount,
    isMember: channel.isMember,
  }));
}

const defaultDeps: SlackConnectDeps = {
  reader: credentialReader,
  launcher: browserLauncher,
  selector: channelSelector,
  fetchChannels: defaultFetchChannels,
  connect: connectIntegration,
  onSignal: (signal, handler) => { process.on(signal, handler); },
  offSignal: (signal, handler) => { process.off(signal, handler); },
};

async function launchBrowserUntilAbort(
  launcher: BrowserLauncher,
  url: string,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<void>((resolve) => {
    onAbort = resolve;
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([
      launcher.launchBrowser(url).then(() => undefined, () => undefined),
      aborted,
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export async function runSlackConnect(
  options: SlackConnectOptions,
  output: IntegrationOutput,
  deps: SlackConnectDeps = defaultDeps,
): Promise<number> {
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  deps.onSignal("SIGINT", onSignal);
  deps.onSignal("SIGTERM", onSignal);

  try {
    const manifest = buildSlackManifestUrl();
    if (!manifest.ok) return output.error("request_failed");

    const handoff = output.event({ status: "browser_required", provider: "slack", url: manifest.url });
    if (handoff !== 0) return handoff;
    if (!options.noOpen) {
      await launchBrowserUntilAbort(deps.launcher, manifest.url, controller.signal);
    }
    if (controller.signal.aborted) return output.error("aborted");

    let credentials: { bot_token: string; app_token: string };
    try {
      credentials = await deps.reader.read("slack", options.source);
    } catch (error) {
      return output.error(error instanceof CredentialInputError ? error.code : "invalid_credential_input");
    }
    output.registerSecrets([credentials.bot_token, credentials.app_token]);

    const format = validateSlackTokenFormat(credentials.bot_token, credentials.app_token);
    if (!format.ok) return output.error("invalid_credential_input");

    let channelIds: string[] = [];
    if (options.source.kind === "tty") {
      let channels: HostedSlackChannel[];
      try {
        channels = await deps.fetchChannels(credentials.bot_token);
      } catch (error) {
        return output.error(error instanceof SlackProviderError ? error.code : "slack_channel_list_failed");
      }
      let selected: string[] | null;
      try {
        selected = await deps.selector.select(channels, controller.signal);
      } catch (error) {
        if (error instanceof ChannelSelectionInterruptedError) return output.error("interrupted");
        throw error;
      }
      if (selected === null) return output.error("invalid_credential_input");
      channelIds = selected;
    }

    const result = await deps.connect({
      provider: "slack",
      bot_token: credentials.bot_token,
      app_token: credentials.app_token,
      channel_ids: channelIds,
    });
    if (!result.ok) return output.error(result.code);

    return output.event({ status: "connected", provider: "slack" });
  } finally {
    deps.offSignal("SIGINT", onSignal);
    deps.offSignal("SIGTERM", onSignal);
  }
}

export interface SlackChannelsListDeps {
  list(): Promise<FetchResult<{ ok: true; channels: HostedSlackChannel[] }>>;
}

const defaultListDeps: SlackChannelsListDeps = { list: listSlackChannels };

export async function runSlackChannelsList(
  output: IntegrationOutput,
  deps: SlackChannelsListDeps = defaultListDeps,
): Promise<number> {
  const result = await deps.list();
  if (!result.ok) return output.error(result.code);
  return output.event({ status: "channels", provider: "slack", channels: result.value.channels });
}

export interface SlackChannelsSetDeps {
  list(): Promise<FetchResult<{ ok: true; channels: HostedSlackChannel[] }>>;
  set(channelIds: string[]): Promise<FetchResult<SlackMembershipReconcileResult>>;
  selector: ChannelSelector;
  preflightTty(): Promise<boolean>;
  onSignal(signal: "SIGINT" | "SIGTERM", handler: () => void): void;
  offSignal(signal: "SIGINT" | "SIGTERM", handler: () => void): void;
}

const defaultSetDeps: SlackChannelsSetDeps = {
  list: listSlackChannels,
  set: setSlackChannels,
  selector: channelSelector,
  preflightTty: () => credentialReader.preflightTty(),
  onSignal: (signal, handler) => { process.on(signal, handler); },
  offSignal: (signal, handler) => { process.off(signal, handler); },
};

export async function runSlackChannelsSet(
  channelIds: string[] | null,
  output: IntegrationOutput,
  deps: SlackChannelsSetDeps = defaultSetDeps,
): Promise<number> {
  let finalIds: string[];
  if (channelIds !== null) {
    finalIds = channelIds;
  } else if (await deps.preflightTty()) {
    const controller = new AbortController();
    const onSignal = () => controller.abort();
    deps.onSignal("SIGINT", onSignal);
    deps.onSignal("SIGTERM", onSignal);
    try {
      const list = await deps.list();
      if (!list.ok) return output.error(list.code);
      let selected: string[] | null;
      try {
        selected = await deps.selector.select(list.value.channels, controller.signal);
      } catch (error) {
        if (error instanceof ChannelSelectionInterruptedError) return output.error("interrupted");
        throw error;
      }
      if (selected === null) return output.error("invalid_credential_input");
      finalIds = selected;
    } finally {
      deps.offSignal("SIGINT", onSignal);
      deps.offSignal("SIGTERM", onSignal);
    }
  } else {
    finalIds = [];
  }

  const result = await deps.set(finalIds);
  if (!result.ok) return output.error(result.code);
  return output.event({ status: "channels_set", provider: "slack", result: result.value });
}
