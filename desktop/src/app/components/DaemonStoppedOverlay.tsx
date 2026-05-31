// DaemonStoppedOverlay.tsx — full-content-area empty state when the daemon is stopped.

export function DaemonStoppedOverlay({
  onStart,
  isStarting,
}: {
  onStart: () => void;
  isStarting?: boolean;
}) {
  return (
    <div className="empty-state">
      <div className="empty-state__icon">⬤</div>
      <p className="empty-state__title">Draft isn't running</p>
      <p className="empty-state__body">Your context isn't being captured.</p>
      <button
        className="empty-state__cta"
        onClick={onStart}
        disabled={isStarting}
      >
        {isStarting ? "Starting…" : "Start Draft"}
      </button>
    </div>
  );
}
