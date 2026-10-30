import { useState } from "react";
import { rpc } from "../../rpc";

/** The two steps of a sign-in with a code: open the page, then type the code there. The code is not part of the link. */
export function DeviceCodeSteps({ url, code }: { url: string; code: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      // The code stays on screen to type by hand.
    }
  }

  return (
    <div className="ui-device">
      <p className="ui-device__step">
        <span className="ui-device__label">1. Open this page</span>
        <button type="button" className="ui-link" onClick={() => rpc.send.openUrl({ url })}>{url}</button>
      </p>
      <p className="ui-device__step">
        <span className="ui-device__label">2. Enter this code there</span>
        <code className="ui-device__code" aria-label="One-time code">{code}</code>
        <button type="button" className="ui-link" onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</button>
      </p>
    </div>
  );
}
