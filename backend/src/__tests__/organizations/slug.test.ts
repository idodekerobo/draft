import { describe, expect, it } from "bun:test";
import { slugify, withRandomSuffix } from "../../organizations/slug";

describe("slugify", () => {
  it("lowercases and joins words with dashes", () => {
    expect(slugify("Acme Robotics")).toBe("acme-robotics");
  });

  it("strips accents and punctuation", () => {
    expect(slugify("  Café & Co.!  ")).toBe("cafe-co");
  });

  it("falls back when nothing usable remains", () => {
    expect(slugify("!!!")).toBe("org");
    expect(slugify("日本語")).toBe("org");
  });

  it("caps the length without a trailing dash", () => {
    const slug = slugify("a".repeat(39) + " bbbbbb");
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith("-")).toBe(false);
  });
});

describe("withRandomSuffix", () => {
  it("appends a 4 character suffix", () => {
    expect(withRandomSuffix("acme")).toMatch(/^acme-[a-z0-9]{4}$/);
  });

  it("varies between calls", () => {
    const values = new Set(Array.from({ length: 20 }, () => withRandomSuffix("acme")));
    expect(values.size).toBeGreaterThan(1);
  });
});
