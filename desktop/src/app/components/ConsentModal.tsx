// desktop/src/app/components/ConsentModal.tsx
// Shown once when analytics.consent === "pending" — after onboarding completes.
// Never shown again once the user has made a choice.

import { useAnalytics } from "../analytics/AnalyticsContext";
import { rpc } from "../rpc";

interface ConsentModalProps {
  onDismiss: () => void;
}

export function ConsentModal({ onDismiss }: ConsentModalProps) {
  const { setConsent, track } = useAnalytics();

  async function handleAccept() {
    await setConsent(true);
    track("analytics_consent_granted", {});
    onDismiss();
  }

  async function handleDecline() {
    await setConsent(false);
    onDismiss();
  }

  return (
    <div className="consent-backdrop" role="dialog" aria-modal="true" aria-labelledby="consent-title">
      <div className="consent-modal">
        <p className="consent-modal__title" id="consent-title">Help improve Draft</p>
        <p className="consent-modal__body">
          Share anonymous usage data so we can understand what's working and fix
          what isn't. No prompts, file content, or personal info are ever collected.
        </p>
        <button
          className="consent-modal__link"
          onClick={() => rpc.send.openUrl({ url: "https://docs.draft.app/analytics" })}
        >
          See exactly what we collect ↗
        </button>
        <div className="consent-modal__actions">
          <button className="empty-state__cta onboarding__cta" onClick={() => void handleAccept()}>
            Yes, help improve Draft
          </button>
          <button className="onboarding__skip" onClick={() => void handleDecline()}>
            No thanks
          </button>
        </div>
      </div>
    </div>
  );
}
