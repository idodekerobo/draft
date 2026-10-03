"use client";

import { useState } from "react";
import { Bot, Link2, Terminal } from "lucide-react";
import type { ToolId } from "./registry";
import { PROVIDER_LOGO_DATA } from "./provider-logo-assets";

const LOGOS: Partial<Record<ToolId, { src: string; monochrome?: boolean }>> = {
  slack: { src: PROVIDER_LOGO_DATA.slack, monochrome: true },
  github: { src: PROVIDER_LOGO_DATA.github, monochrome: true },
  linear: { src: PROVIDER_LOGO_DATA.linear, monochrome: true },
  fireflies: { src: PROVIDER_LOGO_DATA.fireflies },
  granola: { src: PROVIDER_LOGO_DATA.granola },
};

export function ProviderLogo({ providerId }: { providerId: ToolId }) {
  const [failed, setFailed] = useState(false);
  const logo = LOGOS[providerId];
  const Fallback = providerId === "claude-code" ? Bot : providerId === "coding-sessions" ? Terminal : Link2;

  return (
    <span className="ui-provider-logo" aria-hidden="true">
      {logo && !failed
        ? <img className={`ui-provider-logo__image${logo.monochrome ? " ui-provider-logo__image--mono" : ""}`} src={logo.src} alt="" onError={() => setFailed(true)} />
        : <Fallback className="ui-provider-logo__fallback" size={18} strokeWidth={1.7} />}
    </span>
  );
}
