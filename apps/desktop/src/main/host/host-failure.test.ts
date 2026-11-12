import { describe, expect, test } from "bun:test";
import { ServerError, SessionExpiredError } from "../server/server-client";
import { hostFailureAction } from "./host-failure";

describe("hostFailureAction", () => {
  test("pauses when the login is gone", () => { expect(hostFailureAction(new SessionExpiredError())).toBe("pause"); });
  test("pauses when this login cannot reach the session", () => {
    for (const code of ["not_found", "forbidden", "no_team"]) expect(hostFailureAction(new ServerError(code))).toBe("pause");
  });
  test("retries other server errors", () => { expect(hostFailureAction(new ServerError("request_failed_503"))).toBe("retry"); });
  test("retries a network failure", () => { expect(hostFailureAction(new Error("fetch failed"))).toBe("retry"); });
});
