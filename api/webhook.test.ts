import { describe, it, expect, vi, beforeEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

// Mock all external dependencies before importing the handler
vi.mock("@anthropic-ai/sdk", () => {
  const create = vi.fn().mockResolvedValue({
    stop_reason: "end_turn",
    content: [{ type: "text", text: "Here are some gift ideas for you!" }],
  });
  return { default: vi.fn().mockImplementation(() => ({ messages: { create } })) };
});

vi.mock("@mendable/firecrawl-js", () => ({
  default: vi.fn().mockImplementation(() => ({
    search: vi.fn().mockResolvedValue({ web: [] }),
  })),
}));

vi.mock("@vercel/kv", () => ({
  kv: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock fetch globally
const mockFetch = vi.fn().mockResolvedValue({
  json: () => Promise.resolve({}),
  arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
});
vi.stubGlobal("fetch", mockFetch);

// Set required env vars before the module is imported
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
process.env.FIRECRAWL_API_KEY = "test-firecrawl-key";
process.env.KAPSO_API_KEY = "test-kapso-key";
process.env.KAPSO_PHONE_NUMBER_ID = "test-phone-id";
process.env.KAPSO_WEBHOOK_SECRET = "test-secret";

import handler from "./webhook.js";
import { createHmac } from "crypto";

function makeSignature(body: string): string {
  return createHmac("sha256", "test-secret").update(body).digest("hex");
}

function makeReq(
  body: object,
  headers: Record<string, string> = {}
): VercelRequest {
  const raw = JSON.stringify(body);
  return {
    method: "POST",
    headers: {
      "x-webhook-event": "whatsapp.message.received",
      "x-webhook-signature": makeSignature(raw),
      ...headers,
    },
    body,
  } as unknown as VercelRequest;
}

function makeRes() {
  const ctx = { status: 0, body: undefined as unknown };
  const res = {
    status: vi.fn().mockImplementation((s: number) => {
      ctx.status = s;
      return res;
    }),
    json: vi.fn().mockImplementation((b: unknown) => {
      ctx.body = b;
      return res;
    }),
  } as unknown as VercelResponse;
  return { res, ctx };
}

describe("webhook handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({
      json: () => Promise.resolve({}),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    });
  });

  it("rejects non-POST requests", async () => {
    const req = { method: "GET", headers: {} } as unknown as VercelRequest;
    const { res, ctx } = makeRes();
    await handler(req, res);
    expect(ctx.status).toBe(405);
  });

  it("ignores non-message events", async () => {
    const req = {
      method: "POST",
      headers: { "x-webhook-event": "other.event" },
      body: {},
    } as unknown as VercelRequest;
    const { res, ctx } = makeRes();
    await handler(req, res);
    expect(ctx.status).toBe(200);
  });

  it("rejects invalid signatures", async () => {
    const req = makeReq(
      { messages: [{ type: "text", from: "123", id: "1", text: { body: "hi" } }] },
      { "x-webhook-signature": "badsig" }
    );
    const { res, ctx } = makeRes();
    await handler(req, res);
    expect(ctx.status).toBe(401);
  });

  it("acknowledges and processes a text message", async () => {
    const body = {
      messages: [{ type: "text", from: "5215550001", id: "msg1", text: { body: "I need a gift" } }],
    };
    const req = makeReq(body);
    const { res, ctx } = makeRes();
    await handler(req, res);
    expect(ctx.status).toBe(200);
  });

  it("returns 200 for payloads with no messages", async () => {
    const body = { statuses: [{ status: "delivered" }] };
    const req = makeReq(body);
    const { res, ctx } = makeRes();
    await handler(req, res);
    expect(ctx.status).toBe(200);
  });
});
