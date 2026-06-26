import { useEffect, useRef, useState } from "react";
import { useCrispChat } from "../support/useCrispChat";

interface SupportPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SupportPanel({ isOpen, onClose }: SupportPanelProps) {
  const { messages, sendMessage, isReady } = useCrispChat();
  const [draft, setDraft]                  = useState("");
  const messagesEndRef                     = useRef<HTMLDivElement>(null);
  const inputRef                           = useRef<HTMLTextAreaElement>(null);

  // Scroll to bottom when new messages arrive.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Focus input when panel opens.
  useEffect(() => {
    if (isOpen) setTimeout(() => inputRef.current?.focus(), 60);
  }, [isOpen]);

  function handleSend() {
    if (!draft.trim()) return;
    sendMessage(draft);
    setDraft("");
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  if (!isOpen) return null;

  return (
    <div className="support-panel" role="dialog" aria-label="Contact Support">
      <div className="support-panel__header">
        <span className="support-panel__title">Support</span>
        <button className="support-panel__close" onClick={onClose} aria-label="Close support panel">
          ✕
        </button>
      </div>

      <div className="support-panel__messages">
        {messages.length === 0 && (
          <div className="support-panel__empty">
            <p className="support-panel__empty-title">Hi there 👋</p>
            <p className="support-panel__empty-body">
              Send us a message and we'll get back to you as soon as we can.
            </p>
          </div>
        )}
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`support-panel__bubble support-panel__bubble--${msg.from}`}
          >
            {msg.text}
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      <div className="support-panel__footer">
        <textarea
          ref={inputRef}
          className="support-panel__input"
          placeholder="Type a message…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={!isReady}
          rows={2}
        />
        <button
          className="support-panel__send"
          onClick={handleSend}
          disabled={!isReady || !draft.trim()}
          aria-label="Send message"
        >
          Send
        </button>
      </div>
    </div>
  );
}
