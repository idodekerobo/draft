import { beforeEach, describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordRejectedToken } from "../../auth/record-rejected-token";
import { recordError, type RecordErrorInput } from "../../errors/record-error";
import { resetThrottleForTests } from "../../errors/throttle";

const jwtShaped = "aaa.bbb.ccc";
const rows: Array<Record<string, unknown>> = [];
const client = {
  from: () => ({ insert: async (row: Record<string, unknown>) => { rows.push(row); return { error: null }; } }),
} as unknown as SupabaseClient;
// Goes through the real recorder so its redaction applies to the message.
const record = (input: RecordErrorInput) => recordError({ ...input, client });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("recordRejectedToken", () => {
  beforeEach(() => { rows.length = 0; resetThrottleForTests(); });

  it("records an unattributed auth error with the provider's code and a readable message", async () => {
    recordRejectedToken(jwtShaped, { code: "session_not_found", status: 403 }, record);
    await settle();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workspace_id: null, operation: "auth", message: "login rejected by auth provider", detail_json: { code: "session_not_found", status: 403 } });
  });

  it("falls back to the status when the provider gives no code", async () => {
    recordRejectedToken(jwtShaped, { status: 401 }, record);
    await settle();
    expect(rows[0]).toMatchObject({ detail_json: { code: "status_401", status: 401 } });
  });

  it("records a repeated code once per window", async () => {
    recordRejectedToken(jwtShaped, { code: "bad_jwt", status: 401 }, record);
    recordRejectedToken(jwtShaped, { code: "bad_jwt", status: 401 }, record);
    await settle();
    expect(rows).toHaveLength(1);
  });

  it("ignores tokens that are not JWT-shaped", async () => {
    recordRejectedToken("not-a-jwt", { code: "bad_jwt", status: 401 }, record);
    await settle();
    expect(rows).toHaveLength(0);
  });

  it("ignores provider outages and missing errors", async () => {
    recordRejectedToken(jwtShaped, { status: 503 }, record);
    recordRejectedToken(jwtShaped, null, record);
    await settle();
    expect(rows).toHaveLength(0);
  });
});
