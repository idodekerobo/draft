import { describe, expect, it } from "bun:test";
import { assertNotProduction, projectRefFromEnvText } from "../../people/production-guard";

const prodEnv = 'FOO=bar\nSUPABASE_URL="https://prodprodprod.supabase.co"\nSUPABASE_SECRET_KEY=x\n';

describe("assertNotProduction", () => {
  it("reads the project ref from an env file's text", () => {
    expect(projectRefFromEnvText(prodEnv)).toBe("prodprodprod");
    expect(projectRefFromEnvText("SUPABASE_URL=https://abc.supabase.co")).toBe("abc");
    expect(projectRefFromEnvText(undefined)).toBeUndefined();
    expect(projectRefFromEnvText("NOTHING=here")).toBeUndefined();
  });

  it("lets staging through, and stops the production project", () => {
    expect(() => assertNotProduction("https://stagingstaging.supabase.co", prodEnv, { what: "x" })).not.toThrow();
    expect(() => assertNotProduction("https://prodprodprod.supabase.co", prodEnv, { what: "Staging only." })).toThrow("This is the production project. Staging only.");
  });

  it("lets production through only when it was explicitly allowed", () => {
    expect(() => assertNotProduction("https://prodprodprod.supabase.co", prodEnv, { what: "x", allowProd: true })).not.toThrow();
  });

  it("refuses to run with no SUPABASE_URL, and runs when there is no production file to compare with", () => {
    expect(() => assertNotProduction(undefined, prodEnv, { what: "x" })).toThrow("SUPABASE_URL is not set");
    expect(() => assertNotProduction("https://anything.supabase.co", undefined, { what: "x" })).not.toThrow();
  });
});
