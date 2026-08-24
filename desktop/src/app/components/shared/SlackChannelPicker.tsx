// SlackChannelPicker.tsx — channel checkbox list for Slack connection and membership management.

import { useEffect, useState } from "react";
import type { SlackChannelOption } from "../../../rpc/schema";
import { rpc } from "../../rpc";

export interface SlackChannelPickerProps {
  /** Omit to use the token already saved for an already-connected integration. */
  botToken?: string;
  /** Persisted bot membership used to preselect channels in Settings. */
  memberChannelIds?: string[];
  selected: string[];
  onChange: (next: string[]) => void;
}

export function SlackChannelPicker({ botToken, memberChannelIds, selected, onChange }: SlackChannelPickerProps) {
  const [channels, setChannels] = useState<SlackChannelOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const membershipKey = memberChannelIds?.join(",") ?? "";
  const isManageMode = memberChannelIds !== undefined;

  useEffect(() => {
    let cancelled = false;
    setChannels(null);
    setError(null);
    if (!botToken && !isManageMode) {
      setChannels([]);
      setError("No saved Slack credential is available. Connect Slack again to choose channels.");
      return () => { cancelled = true; };
    }
    rpc.request.listSlackChannels({ botToken })
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          setError(result.error ?? "Could not load channels.");
          setChannels([]);
          return;
        }
        setChannels(result.channels ?? []);
      })
      .catch(() => {
        if (!cancelled) {
          setError("Could not load channels.");
          setChannels([]);
        }
      });
    return () => { cancelled = true; };
  }, [botToken, membershipKey, isManageMode]);

  function toggle(id: string) {
    onChange(selected.includes(id) ? selected.filter((c) => c !== id) : [...selected, id]);
  }

  if (channels === null) {
    return <p className="slack-channel-picker__status">Loading channels…</p>;
  }
  if (error) {
    return <p className="slack-channel-picker__status slack-channel-picker__status--error">{error}</p>;
  }
  if (channels.length === 0) {
    return <p className="slack-channel-picker__status">No channels found. Create one in Slack first.</p>;
  }

  return (
    <div className="slack-channel-picker__body">
      {channels.map((channel) => (
        <label key={channel.id} className="slack-channel-picker__row">
          <input type="checkbox" checked={selected.includes(channel.id)} onChange={() => toggle(channel.id)} />
          <span className="slack-channel-picker__name">#{channel.name}</span>
          <span className="slack-channel-picker__meta">{channel.memberCount} members</span>
          {channel.isMember && <span className="slack-channel-picker__badge">already joined ✓</span>}
        </label>
      ))}
    </div>
  );
}
