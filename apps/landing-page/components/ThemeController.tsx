"use client";

import { useEffect } from "react";

export type LandingTheme = "light" | "dark";

export function setLandingTheme(theme: LandingTheme) {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.classList.toggle("light", theme === "light");
  root.dataset.theme = theme;
}

export function toggleLandingTheme() {
  setLandingTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
}

export default function ThemeController() {
  useEffect(() => {
    const handleTheme = (event: Event) => {
      const theme = (event as CustomEvent<{ theme?: LandingTheme }>).detail?.theme;
      if (theme === "light" || theme === "dark") setLandingTheme(theme);
      else toggleLandingTheme();
    };
    window.addEventListener("draft:theme", handleTheme);
    return () => window.removeEventListener("draft:theme", handleTheme);
  }, []);
  return null;
}
