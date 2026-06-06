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
        <div className="consent-modal__header">
          <p className="consent-modal__title" id="consent-title">Help improve Draft</p>
          <p className="consent-modal__subtitle">Anonymous · No prompts or file content</p>
        </div>
        <p className="consent-modal__body">
          Share usage data so we can see where people get stuck and what's working.
          We collect navigation patterns and error codes — nothing you type or write.
        </p>
        <button
          className="consent-modal__link"
          onClick={() => rpc.send.openUrl({ url: "https://docs.draft.app/analytics" })}
        >
          See exactly what we collect ↗
        </button>
        <div className="consent-modal__actions">
          <button className="consent-modal__btn consent-modal__btn--accept" onClick={() => void handleAccept()}>
            Yes, help improve Draft
          </button>
          <button className="consent-modal__btn consent-modal__btn--decline" onClick={() => void handleDecline()}>
            No thanks
          </button>
        </div>
      </div>
    </div>
  );
}
