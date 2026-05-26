import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { DeliverResult, ResolvedAiNexusAccount } from "./types.js";
import { createWebhookHandler } from "./webhook-handler.js";

type MockIncomingMessage = IncomingMessage & {
  destroyed?: boolean;
  destroy: () => MockIncomingMessage;
  socket: { remoteAddress: string };
};

function createJsonRequest(body: unknown): MockIncomingMessage {
  const req = new EventEmitter() as MockIncomingMessage;
  req.method = "POST";
  req.headers = {
    "content-type": "application/json",
  };
  req.socket = { remoteAddress: "127.0.0.1" } as MockIncomingMessage["socket"];
  req.destroyed = false;
  req.destroy = (() => {
    req.destroyed = true;
    return req;
  }) as MockIncomingMessage["destroy"];
  void Promise.resolve().then(() => {
    req.emit("data", Buffer.from(JSON.stringify(body), "utf8"));
    req.emit("end");
  });
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

function createAccount(): ResolvedAiNexusAccount {
  return {
    accountId: "default",
    enabled: true,
    token: "webhook-token",
    webhookPath: "/webhook/ai-nexus",
    dmPolicy: "open",
    allowedSenderIds: [],
    execApprovals: true,
  };
}

describe("createWebhookHandler", () => {
  it("uses signalr callback path for sync requests when signalr context exists", async () => {
    const deliverMock = vi.fn(
      async (): Promise<DeliverResult> => ({
        text: ["should-not-be-returned-in-sync-body"],
        media: [],
      }),
    );
    const handler = createWebhookHandler({
      account: createAccount(),
      deliver: deliverMock,
    });

    const req = createJsonRequest({
      webhookToken: "webhook-token",
      senderId: "alice",
      text: "hello",
      sync: true,
      signalrGroupId: "group-1",
      signalrToken: "signalr-token",
    });
    const res = createMockResponse();

    await handler(req, res);

    expect(res.statusCode).toBe(204);
    expect(deliverMock).toHaveBeenCalledTimes(1);
  });

  it("keeps sync JSON response as fallback when signalr context is missing", async () => {
    const deliverMock = vi.fn(
      async (): Promise<DeliverResult> => ({
        text: ["fallback-reply"],
        media: [],
      }),
    );
    const handler = createWebhookHandler({
      account: createAccount(),
      deliver: deliverMock,
    });

    const req = createJsonRequest({
      webhookToken: "webhook-token",
      senderId: "alice",
      text: "hello",
      sync: true,
    });
    const res = createMockResponse();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(String(res.body))).toEqual({
      reply: ["fallback-reply"],
    });
    expect(deliverMock).toHaveBeenCalledTimes(1);
  });
});
