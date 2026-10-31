"use client";

/** An icon button that goes back one step. It names no page, because the page it leaves already says where the person is. */
export function BackButton({ onClick, label = "Back" }: { onClick: () => void; label?: string }) {
  return (
    <button type="button" className="ui-btn ui-btn--icon ui-btn--back" onClick={onClick} aria-label={label} title={label}>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M10 3.5 5.5 8l4.5 4.5" />
      </svg>
    </button>
  );
}
