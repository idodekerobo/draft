"use client";

import { useEffect, useState } from "react";
import { Toaster as SonnerToaster } from "sonner";

type ResolvedTheme = "light" | "dark";

function readTheme(): ResolvedTheme {
  const explicit = document.documentElement.dataset.theme;
  if (explicit === "light" || explicit === "dark") return explicit;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** Mount once at each app root. Follows the resolved Light/Dark/System theme. */
export function Toaster() {
  const [theme, setTheme] = useState<ResolvedTheme>("dark");

  useEffect(() => {
    setTheme(readTheme());
    const observer = new MutationObserver(() => setTheme(readTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const media = window.matchMedia?.("(prefers-color-scheme: light)");
    const onChange = () => setTheme(readTheme());
    media?.addEventListener("change", onChange);
    return () => {
      observer.disconnect();
      media?.removeEventListener("change", onChange);
    };
  }, []);

  return (
    <SonnerToaster
      theme={theme}
      position="bottom-right"
      closeButton
      offset={24}
      mobileOffset={16}
      toastOptions={{
        style: {
          background: "var(--color-bg-elevated)",
          color: "var(--color-text-primary)",
          border: "1px solid var(--color-border-strong)",
          fontFamily: "var(--font-ui)",
          borderRadius: "var(--radius-notice)",
        },
      }}
    />
  );
}
