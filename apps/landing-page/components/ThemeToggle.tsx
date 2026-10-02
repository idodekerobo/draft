"use client";

import { useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";
import { toggleLandingTheme } from "@/components/ThemeController";

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => observer.disconnect();
}

export default function ThemeToggle() {
  const isDark = useSyncExternalStore(
    subscribe,
    () => document.documentElement.dataset.theme === "dark",
    () => false,
  );
  const label = isDark ? "Switch to light theme" : "Switch to dark theme";
  const Icon = isDark ? Sun : Moon;

  return (
    <button
      type="button"
      className="minimal-theme-toggle"
      aria-label={label}
      title={label}
      onClick={toggleLandingTheme}
    >
      <Icon size={18} strokeWidth={1.5} aria-hidden="true" />
    </button>
  );
}
