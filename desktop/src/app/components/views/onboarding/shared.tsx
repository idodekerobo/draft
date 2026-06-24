// shared.tsx — shared UI components for onboarding steps

import { useState } from "react";

export function CopyableCmd({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false);
  function handleCopy() {
    void navigator.clipboard.writeText(cmd).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    });
  }
  return (
    <button className="onboarding__cmd" onClick={handleCopy} title="Copy to clipboard">
      <span className="onboarding__cmd-text">{cmd}</span>
      <span className="onboarding__cmd-copy">{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}
