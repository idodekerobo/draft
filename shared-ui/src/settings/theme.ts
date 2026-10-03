export type ThemePreference = "light" | "dark" | "system";

export const THEME_STORAGE_KEY = "draft.theme";

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

/** "system" removes data-theme so tokens.css follows the OS. */
export function applyTheme(preference: ThemePreference, root: HTMLElement = document.documentElement): void {
  if (preference === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", preference);
  const owner = root.ownerDocument;
  if (owner?.documentElement === root) {
    const meta = owner.querySelector('meta[name="theme-color"]');
    const systemIsDark = owner.defaultView?.matchMedia("(prefers-color-scheme: dark)").matches ?? false;
    if (meta) meta.setAttribute("content", preference === "light" ? "#faf8f5" : preference === "dark" ? "#211f1d" : systemIsDark ? "#211f1d" : "#faf8f5");
  }
}

/** Inline <head> script for web: applies a stored explicit theme before first paint. */
export const THEME_BOOT_SCRIPT = `try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t);var m=document.querySelector('meta[name="theme-color"]');var q=matchMedia("(prefers-color-scheme: dark)");var s=function(){if(m)m.setAttribute("content",t==="light"?"#faf8f5":t==="dark"?"#211f1d":q.matches?"#211f1d":"#faf8f5")};s();if(t!=="light"&&t!=="dark")q.addEventListener("change",s)}catch(e){}`;
