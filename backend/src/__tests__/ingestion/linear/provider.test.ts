import { describe, expect, it, mock } from "bun:test";
import {
  createLinearWebhook,
  deleteLinearWebhook,
  LinearProviderError,
} from "../../../ingestion/linear/provider";

describe("Linear provider domain", () => {
  it("creates a webhook, validates the response, and returns its id", async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    const fetchFn = mock(async (input: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(input), init };
      return Response.json({
        data: { webhookCreate: { success: true, webhook: { id: "webhook-123", enabled: true } } },
      });
    }) as unknown as typeof fetch;

    await expect(createLinearWebhook(
      "linear-api-token",
      "https://api.example.test/webhooks/linear/key",
      "linear-signing-secret",
      fetchFn,
    )).resolves.toEqual({ id: "webhook-123" });

    expect(captured?.url).toBe("https://api.linear.app/graphql");
    expect(captured?.init?.method).toBe("POST");
    expect(new Headers(captured?.init?.headers).get("authorization")).toBe("linear-api-token");
    const body = JSON.parse(String(captured?.init?.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    expect(body.query).toContain("webhookCreate");
    expect(body.variables).toEqual({
      url: "https://api.example.test/webhooks/linear/key",
      resourceTypes: ["Issue", "Comment", "Project", "Cycle", "ProjectUpdate"],
      secret: "linear-signing-secret",
    });
  });

  it("deletes a webhook with only its upstream id", async () => {
    let body: { query: string; variables: Record<string, unknown> } | undefined;
    const fetchFn = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ data: { webhookDelete: { success: true } } });
    }) as unknown as typeof fetch;

    await expect(deleteLinearWebhook("linear-api-token", "webhook-123", fetchFn)).resolves.toBeUndefined();
    expect(body?.query).toContain("webhookDelete");
    expect(body?.variables).toEqual({ id: "webhook-123" });
  });

  it("maps every unsafe create failure shape to linear_webhook_create_failed", async () => {
    const canary = "canary-raw-linear-response";
    const failures: Array<() => Response | Promise<Response>> = [
      () => new Response(canary, { status: 502 }),
      () => new Response("not-json", { status: 200 }),
      () => Response.json({ errors: [{ message: canary }] }),
      () => Response.json({ data: { webhookCreate: { success: false } } }),
      () => Response.json({ data: { webhookCreate: { success: true, webhook: {} } } }),
    ];

    for (const response of failures) {
      const fetchFn = mock(async () => response()) as unknown as typeof fetch;
      try {
        await createLinearWebhook("api-token-canary", "https://example.test/hook", "secret-canary", fetchFn);
        throw new Error("expected create failure");
      } catch (error) {
        expect(error).toBeInstanceOf(LinearProviderError);
        expect((error as LinearProviderError).code).toBe("linear_webhook_create_failed");
        expect((error as Error).message).toBe("linear_webhook_create_failed");
        expect((error as Error).message).not.toContain(canary);
        expect((error as Error).message).not.toContain("api-token-canary");
        expect((error as Error).message).not.toContain("secret-canary");
      }
    }
  });

  it("maps delete rejection and transport errors to linear_webhook_delete_failed", async () => {
    const canary = "canary-delete-provider-detail";
    const rejected = mock(async () => Response.json({
      errors: [{ message: canary }],
    })) as unknown as typeof fetch;
    const transport = mock(async () => {
      throw new Error(canary);
    }) as unknown as typeof fetch;

    for (const fetchFn of [rejected, transport]) {
      try {
        await deleteLinearWebhook("linear-api-token", "webhook-id", fetchFn);
        throw new Error("expected delete failure");
      } catch (error) {
        expect(error).toBeInstanceOf(LinearProviderError);
        expect((error as LinearProviderError).code).toBe("linear_webhook_delete_failed");
        expect((error as Error).message).toBe("linear_webhook_delete_failed");
        expect((error as Error).message).not.toContain(canary);
      }
    }
  });
});
