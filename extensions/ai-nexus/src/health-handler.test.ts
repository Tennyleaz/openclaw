import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";

vi.mock("./client.js", () => ({
  isAiNexusSignalrConnected: vi.fn(() => false),
}));

import { createHealthHandler } from "./health-handler.js";
import type { ResolvedAiNexusAccount } from "./types.js";

type MockIncomingMessage = IncomingMessage & {
  socket: { remoteAddress: string };
};

function createRequest(
  method: string,
  options: { authorization?: string; url?: string } = {},
): MockIncomingMessage {
  const req = new EventEmitter() as MockIncomingMessage;
  req.method = method;
  req.url = options.url ?? "/webhook/ai-nexus/health";
  req.headers =
    options.authorization !== undefined ? { authorization: options.authorization } : {};
  req.socket = { remoteAddress: "127.0.0.1" } as MockIncomingMessage["socket"];
  return req;
}

function createMockResponse(): ServerResponse & { body?: string } {
  const res = {
    statusCode: 200,
    body: "",
    headers: {} as Record<string, string>,
    writeHead(statusCode: number, headers?: Record<string, string>) {
      this.statusCode = statusCode;
      if (headers) {
        this.headers = { ...this.headers, ...headers };
      }
      return this;
    },
    write(chunk: string) {
      this.body += chunk;
      return true;
    },
    end(chunk?: string) {
      if (chunk) {
        this.body += chunk;
      }
      return this;
    },
  };
  return res as unknown as ServerResponse & { body?: string };
}

function createAccount(
  overrides: Partial<ResolvedAiNexusAccount> = {},
): ResolvedAiNexusAccount {
  return {
    accountId: "default",
    enabled: true,
    token: "webhook-token",
    webhookPath: "/webhook/ai-nexus",
    dmPolicy: "open",
    allowedSenderIds: [],
    execApprovals: true,
    ...overrides,
  };
}

describe("createHealthHandler", () => {
  it("returns 405 for POST", async () => {
    const handler = createHealthHandler({ account: createAccount() });
    const req = createRequest("POST", { authorization: "Bearer webhook-token" });
    const res = createMockResponse();

    handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toBe("GET");
  });

  it("returns 405 for PUT", async () => {
    const handler = createHealthHandler({ account: createAccount() });
    const req = createRequest("PUT", { authorization: "Bearer webhook-token" });
    const res = createMockResponse();

    handler(req, res);

    expect(res.statusCode).toBe(405);
  });

  it("returns 405 for DELETE", async () => {
    const handler = createHealthHandler({ account: createAccount() });
    const req = createRequest("DELETE", { authorization: "Bearer webhook-token" });
    const res = createMockResponse();

    handler(req, res);

    expect(res.statusCode).toBe(405);
  });

  it("returns 401 with WWW-Authenticate when Authorization header is missing", async () => {
    const handler = createHealthHandler({ account: createAccount() });
    const req = createRequest("GET");
    const res = createMockResponse();

    handler(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.headers["WWW-Authenticate"]).toMatch(/^Bearer/);
    expect(JSON.parse(String(res.body)).error).toMatch(/Bearer/);
  });

  it("returns 401 for a non-Bearer scheme (Basic)", async () => {
    const handler = createHealthHandler({ account: createAccount() });
    const req = createRequest("GET", { authorization: "Basic d2ViaG9vay10b2tlbg==" });
    const res = createMockResponse();

    handler(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.headers["WWW-Authenticate"]).toMatch(/^Bearer/);
  });

  it("returns 401 when Bearer value is empty", async () => {
    const handler = createHealthHandler({ account: createAccount() });
    const req = createRequest("GET", { authorization: "Bearer   " });
    const res = createMockResponse();

    handler(req, res);

    expect(res.statusCode).toBe(401);
  });

  it("returns 401 for a wrong token of the same length", async () => {
    const handler = createHealthHandler({ account: createAccount({ token: "abcdef" }) });
    const req = createRequest("GET", { authorization: "Bearer zzzzzz" });
    const res = createMockResponse();

    handler(req, res);

    expect(res.statusCode).toBe(401);
  });

  it("returns 401 for a wrong-length token (timingSafeEqual length guard)", async () => {
    const handler = createHealthHandler({ account: createAccount({ token: "webhook-token" }) });
    const req = createRequest("GET", { authorization: "Bearer webhook" });
    const res = createMockResponse();

    handler(req, res);

    expect(res.statusCode).toBe(401);
  });

  it("ignores a query-string token (no ?token= fallback)", async () => {
    const handler = createHealthHandler({ account: createAccount({ token: "webhook-token" }) });
    const req = createRequest("GET", {
      url: "/webhook/ai-nexus/health?token=webhook-token",
    });
    const res = createMockResponse();

    handler(req, res);

    expect(res.statusCode).toBe(401);
  });

  it("returns 200 JSON with expected fields for a valid Bearer token", async () => {
    const before = Date.now();
    const handler = createHealthHandler({
      account: createAccount({ accountId: "acct-42", enabled: true, token: "webhook-token" }),
    });
    const req = createRequest("GET", { authorization: "Bearer webhook-token" });
    const res = createMockResponse();

    handler(req, res);
    const after = Date.now();

    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(String(res.body)) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.channel).toBe("ai-nexus");
    expect(body.accountId).toBe("acct-42");
    expect(body.enabled).toBe(true);
    expect(body.signalrConnected).toBe(false);
    expect(typeof body.ts).toBe("number");
    expect(body.ts as number).toBeGreaterThanOrEqual(before);
    expect(body.ts as number).toBeLessThanOrEqual(after);
  });

  it("accepts case-insensitive Bearer scheme", async () => {
    const handler = createHealthHandler({ account: createAccount() });
    const req = createRequest("GET", { authorization: "bearer webhook-token" });
    const res = createMockResponse();

    handler(req, res);

    expect(res.statusCode).toBe(200);
  });

  it("surfaces signalrConnected=true when the client reports connected", async () => {
    const { isAiNexusSignalrConnected } = (await import("./client.js")) as {
      isAiNexusSignalrConnected: ReturnType<typeof vi.fn>;
    };
    isAiNexusSignalrConnected.mockReturnValueOnce(true);

    const handler = createHealthHandler({ account: createAccount() });
    const req = createRequest("GET", { authorization: "Bearer webhook-token" });
    const res = createMockResponse();

    handler(req, res);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(String(res.body)) as Record<string, unknown>;
    expect(body.signalrConnected).toBe(true);
  });

  it("returns 401 when account has no configured token (validateToken empty-expected guard)", async () => {
    const handler = createHealthHandler({
      account: createAccount({ token: "" as unknown as string }),
    });
    const req = createRequest("GET", { authorization: "Bearer anything" });
    const res = createMockResponse();

    handler(req, res);

    expect(res.statusCode).toBe(401);
  });
});
