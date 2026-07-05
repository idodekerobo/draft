import { useCallback, useEffect, useRef, useState } from "react";
import { Crisp } from "crisp-sdk-web";
import { rpc } from "../rpc";

export interface CrispMessage {
  id: string;
  from: "user" | "operator";
  text: string;
  timestamp: number;
}

interface CrispRawMessage {
  fingerprint: number;
  type: string;
  from: string;
  content: unknown;
  timestamp: number;
}

// Module-level flag — Crisp can only be configured once per page load.
let _configured = false;

export function useCrispChat() {
  const [messages, setMessages]   = useState<CrispMessage[]>([]);
  const [isReady, setIsReady]     = useState(false);
  const listenerBound             = useRef(false);
  const historyLoaded             = useRef(false);

  useEffect(() => {
    async function init() {
      const cfg = await rpc.request.getCrispConfig();

      if (_configured) {
        setIsReady(true);
        return;
      }

      if (!cfg.website_id) return; // OSS build — no Crisp key

      Crisp.configure(cfg.website_id, { autoload: false });
      Crisp.load();
      Crisp.chat.hide();
      _configured = true;
      setIsReady(true);

      if (cfg.history_endpoint && cfg.history_secret) {
        Crisp.session.onLoaded((sessionId: string) => {
          if (historyLoaded.current || !sessionId) return;
          historyLoaded.current = true;
          fetch(cfg.history_endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${cfg.history_secret}`,
            },
            body: JSON.stringify({ session_id: sessionId }),
          })
            .then((r) => r.json())
            .then((data: { messages?: CrispRawMessage[] }) => {
              const mapped = (data.messages ?? [])
                .filter((m) => m.type === "text")
                .map((m) => ({
                  id:        String(m.fingerprint),
                  from:      m.from as "user" | "operator",
                  text:      typeof m.content === "string" ? m.content : "",
                  timestamp: m.timestamp,
                }));
              if (mapped.length) setMessages(mapped);
            })
            .catch(() => { /* history unavailable — silent fail */ });
        });
      }
    }

    void init();
  }, []);

  useEffect(() => {
    if (!isReady || listenerBound.current) return;
    listenerBound.current = true;

    Crisp.message.onMessageReceived((msg: unknown) => {
      const m = msg as Record<string, unknown>;
      const text = typeof m?.content === "string" ? m.content : "";
      if (!text) return;

      setMessages((prev) => [
        ...prev,
        {
          id:        String(m?.fingerprint ?? Date.now()),
          from:      "operator",
          text,
          timestamp: typeof m?.timestamp === "number" ? m.timestamp : Date.now(),
        },
      ]);
    });
  }, [isReady]);

  const sendMessage = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!isReady || !trimmed) return;

    setMessages((prev) => [
      ...prev,
      { id: String(Date.now()), from: "user", text: trimmed, timestamp: Date.now() },
    ]);

    Crisp.message.send("text", trimmed);
  }, [isReady]);

  return { messages, sendMessage, isReady };
}
