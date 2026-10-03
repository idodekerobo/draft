import { describe, expect, test } from "bun:test";
import { applyTheme, THEME_BOOT_SCRIPT, THEME_STORAGE_KEY } from "./theme";

describe("theme preference initialization", () => {
  test("web boot script reads the persisted preference before render", () => {
    expect(THEME_BOOT_SCRIPT).toContain(THEME_STORAGE_KEY);
    expect(THEME_BOOT_SCRIPT).toContain('t==="light"||t==="dark"');
  });

  test("explicit themes set data-theme and system removes it", () => {
    const attrs = new Map<string, string>();
    const root = {
      setAttribute: (name: string, value: string) => attrs.set(name, value),
      removeAttribute: (name: string) => attrs.delete(name),
    } as unknown as HTMLElement;
    applyTheme("dark", root);
    expect(attrs.get("data-theme")).toBe("dark");
    applyTheme("system", root);
    expect(attrs.has("data-theme")).toBe(false);
  });
});
