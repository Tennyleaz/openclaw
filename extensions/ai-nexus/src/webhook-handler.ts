// oxlint-disable no-unused-vars
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
} from "openclaw/plugin-sdk/webhook-ingress";
import { validateToken } from "./auth.js";
import {
  sendMessage,
  sendMediaFile,
  sendExecApproval,
  setAiNexusSignalrContext,
} from "./client.js";
import { isAiNexusSenderAllowed } from "./policy.js";
import type {
  AiNexusWebhookPayload,
  DeliverEvent,
  WebhookHandlerDeps,
} from "./types.js";

function respondJson(res: ServerResponse, statusCode: number, body: Record<string, unknown>) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function respondNoContent(res: ServerResponse) {
  res.writeHead(204);
  res.end();
}

async function readBody(
  req: IncomingMessage,
): Promise<{ ok: true; body: string } | { ok: false; statusCode: number; error: string }> {
  try {
    const body = await readRequestBodyWithLimit(req, {
      maxBytes: 1_048_576,
      timeoutMs: 30_000,
    });
    return { ok: true, body };
  } catch (err) {
    if (isRequestBodyLimitError(err)) {
      return { ok: false, statusCode: err.statusCode, error: requestBodyErrorToText(err.code) };
    }
    return { ok: false, statusCode: 400, error: "Invalid request body" };
  }
}

function parseJsonPayload(body: string): AiNexusWebhookPayload | null {
  if (!body.trim()) {
    return null;
  }
  const parsed = JSON.parse(body);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const webhookToken = typeof parsed.webhookToken === "string" ? parsed.webhookToken.trim() : "";
  const senderId = typeof parsed.senderId === "string" ? parsed.senderId.trim() : "";
  const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
  const senderName = typeof parsed.senderName === "string" ? parsed.senderName.trim() : undefined;
  const sync = parsed.sync === true;
  const stream = parsed.stream === true;
  const signalrGroupId =
    typeof parsed.signalrGroupId === "string" ? parsed.signalrGroupId.trim() : undefined;
  const signalrToken =
    typeof parsed.signalrToken === "string" ? parsed.signalrToken.trim() : undefined;

  if (!webhookToken || !senderId || !text) {
    return null;
  }
  return { webhookToken, senderId, text, senderName, sync, stream, signalrGroupId, signalrToken };
}

/**
 * Create an HTTP request handler for AI Nexus inbound webhooks.
 *
 * Flow:
 * 1. Accept POST only
 * 2. Parse JSON body into AiNexusWebhookPayload
 * 3. Validate token (constant-time)
 * 4. Check DM policy / allowlist
 * 5. ACK with 204
 * 6. Deliver message to the agent asynchronously
 */
export function createWebhookHandler(deps: WebhookHandlerDeps) {
  const { account, deliver, log } = deps;

  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") {
      respondJson(res, 405, { error: "Method not allowed" });
      return;
    }

    const bodyResult = await readBody(req);
    if (!bodyResult.ok) {
      log?.error("Failed to read request body", bodyResult.error);
      respondJson(res, bodyResult.statusCode, { error: bodyResult.error });
      return;
    }

    let payload: AiNexusWebhookPayload | null = null;
    try {
      payload = parseJsonPayload(bodyResult.body);
    } catch (err) {
      log?.warn("Failed to parse webhook payload", err);
      respondJson(res, 400, { error: "Invalid JSON body" });
      return;
    }
    if (!payload) {
      respondJson(res, 400, { error: "Missing required fields (webhookToken, senderId, text)" });
      return;
    }

    if (!validateToken(payload.webhookToken, account.token)) {
      log?.warn(`Invalid token from ${req.socket?.remoteAddress}`);
      respondJson(res, 401, { error: "Invalid token" });
      return;
    }

    const auth = isAiNexusSenderAllowed(
      payload.senderId,
      account.dmPolicy,
      account.allowedSenderIds,
    );
    if (!auth.allowed) {
      if (auth.reason === "disabled") {
        respondJson(res, 403, { error: "DMs are disabled" });
        return;
      }
      if (auth.reason === "allowlist-empty") {
        log?.warn("AI Nexus allowlist is empty while dmPolicy=allowlist; rejecting message");
        respondJson(res, 403, {
          error: "Allowlist is empty. Configure allowedSenderIds or use dmPolicy=open.",
        });
        return;
      }
      log?.warn(`Unauthorized sender: ${payload.senderId}`);
      respondJson(res, 403, { error: "Sender not authorized" });
      return;
    }

    setAiNexusSignalrContext(account.accountId, payload.senderId, {
      groupId: payload.signalrGroupId,
      token: payload.signalrToken,
    });

    const preview = payload.text.length > 100 ? `${payload.text.slice(0, 100)}...` : payload.text;
    log?.info(
      `Message from ${payload.senderName ?? payload.senderId} (${payload.senderId}): ${preview}`,
    );

    const deliverMsg = {
      body: payload.text,
      from: payload.senderId,
      senderName: payload.senderName ?? payload.senderId,
      provider: "ai-nexus",
      chatType: "direct",
      sessionKey: `ai-nexus-${payload.senderId}`,
      accountId: account.accountId,
    };
    //console.log("deliverMsg", deliverMsg);
    const signalrCallbackContext =
      payload.signalrGroupId && payload.signalrToken
        ? { groupId: payload.signalrGroupId, token: payload.signalrToken }
        : undefined;
    //const hasSignalrCallback = Boolean(signalrCallbackContext);

    if (payload.sync) {
      try {
        // We have whole result into string array
        const result = await deliver(deliverMsg, (event) => {
          // In sync mode, we don't send signalr, else ainexus bridge MCP and signalr client will both get messages!
          // if (signalrCallbackContext) {
          //   void forwardSignalrEvent(event, signalrCallbackContext, log);
          // } else {
          //   console.log("signalrCallbackContext is null, will not call signalr.");
          // }
        });
        const response: Record<string, unknown> = { reply: result.text };
        if (result.media.length > 0) {
          response.media = result.media;
        }
        respondJson(res, 200, response);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log?.error(`Failed to process message from ${payload.senderId}: ${errMsg}`);
        respondJson(res, 500, { error: "Agent processing failed" });
      }
    } else if (payload.stream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      try {
        // We don't need to keep async result
        await deliver(deliverMsg, (event) => {
          if (event.type === "text") {
            res.write(`data: ${JSON.stringify({ type: "chunk", text: event.text })}\n\n`);
          } else if (event.type === "tool") {
            res.write(`data: ${JSON.stringify({ type: "tool", text: event.toolName })}\n\n`);
          } else if (event.type === "media") {
            const finalUrl = event.dataUrl ?? event.url;
            const mediaEvent: Record<string, string> = { type: "media", url: finalUrl };
            if (event.contentType) {
              mediaEvent.contentType = event.contentType;
            }
            res.write(`data: ${JSON.stringify(mediaEvent)}\n\n`);
          }
          if (signalrCallbackContext) {
            void forwardSignalrEvent(event, signalrCallbackContext, log);
          } else {
            console.log("signalrCallbackContext is null, will not call signalr.");
          }
        });
        // Do not send collected text or media here again. Just send the "done" signal.
        const donePayload: Record<string, unknown> = {
          type: "done",
          //reply: result.text ?? "",
        };
        //if (result.media.length > 0) {
        //  donePayload.media = result.media;
        //}
        res.write(`data: ${JSON.stringify(donePayload)}\n\n`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log?.error(`Failed to process message from ${payload.senderId}: ${errMsg}`);
        res.write(
          `data: ${JSON.stringify({ type: "error", error: "Agent processing failed" })}\n\n`,
        );
      }
      res.end();
    } else {
      respondNoContent(res);
      deliver(deliverMsg, (event) => {
        // In fire and forget mode, also send event-by-event callback POSTs when SignalR context is available.
        if (signalrCallbackContext) {
          void forwardSignalrEvent(event, signalrCallbackContext, log);
        } else {
          console.log("signalrCallbackContext is null, will not call signalr.");
        }
      }).catch((err) => {
        const errMsg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
        log?.error(`Failed to process message from ${payload.senderId}: ${errMsg}`);
      });
    }

    console.log("message delivered.");
  };
}

export async function forwardSignalrEvent(
  event: DeliverEvent,
  callback: { groupId: string; token: string },
  log?: {
    warn: (...args: unknown[]) => void;
  },
) {
  const { groupId, token } = callback;
  let ok = false;
  if (event.type === "text") {
    ok = await sendMessage(event.type, event.text, token, groupId);
  } else if (event.type === "tool") {
    ok = await sendMessage(event.type, event.toolName, token, groupId);
  } else if (event.type === "media") {
    ok = await sendMediaFile(event.url, token, groupId);
  } else if (event.type === "approval") {
    const messageId = await sendExecApproval(event.approvalId, event.command, token, groupId);
    ok = !!messageId;
  }

  if (!ok) {
    log?.warn("Failed to deliver SignalR callback event");
  }
}
