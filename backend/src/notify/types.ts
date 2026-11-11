import type { NotifyChannelId, NotifyMessage, ChannelSendResult } from "draft-core/notify";
import type { PersonId, WorkspaceId } from "draft-core/run-spec";

declare const checked: unique symbol;

/**
 * A person who may be messaged: in the caller's workspace, `active`, and a `member`. Only `resolvePerson`
 * makes one, so a channel can never be handed a person nobody checked.
 */
export type ReachablePerson = {
  readonly [checked]: true;
  readonly id: PersonId;
  readonly workspaceId: WorkspaceId;
  readonly displayName: string;
  readonly userId: string | null;
  readonly notifyChannels: ReadonlyArray<NotifyChannelId>;
};

/** Builds the value `resolvePerson` returns. Kept here so the brand is made in one place. */
export const markReachable = (person: Omit<ReachablePerson, typeof checked>): ReachablePerson => person as ReachablePerson;

export interface NotifyChannel {
  id: NotifyChannelId;
  /** True when the person has a confirmed or from_connection identity for this channel and the workspace has it connected. */
  canReach(person: ReachablePerson): Promise<boolean>;
  send(person: ReachablePerson, message: NotifyMessage): Promise<ChannelSendResult>;
}
