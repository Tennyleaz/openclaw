import type { IncomingMessage, ServerResponse } from "node:http";
import { extractBearerToken, validateToken } from "./auth.js";
import { isAiNexusSignalrConnected } from "./client.js";
import type { ResolvedAiNexusAccount } from "./types.js";

export interface HealthHandlerDeps {
  account: ResolvedAiNexusAccount;
  log?: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}

function respondJson(res: ServerResponse, statusCode: number, body: Record<string, unknown>) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function respondUnauthorized(res: ServerResponse, message: string) {
  res.writeHead(401, {
    "Content-Type": "application/json",
    "WWW-Authenticate": 'Bearer realm="ai-nexus", charset="UTF-8"',
  });
  res.end(JSON.stringify({ error: message }));
}

/**
 * Create an HTTP request handler for the AI Nexus channel's health probe.
 *
 * Flow:
 * 1. Accept GET only (405 otherwise)
 * 2. Require `Authorization: Bearer <token>` matching the account token
 *    (constant-time compare). No query-string fallback.
 * 3. Return a tiny JSON status snapshot without invoking the agent, parsing
 *    the body, or emitting any outbound traffic.
 *
 * Only the `Authorization` header is accepted so that tokens are never written
 * to access logs / referrers / shell history the way a `?token=` query string
 * would be, and so the existing OpenClaw log scrubber (which redacts
 * `Authorization: Bearer ...`) automatically protects probe traffic.
 */
export function createHealthHandler(deps: HealthHandlerDeps) {
  const { account, log } = deps;

  return (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "application/json", Allow: "GET" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    const token = extractBearerToken(req);
    if (!token) {
      log?.warn(
        `[ai-nexus] health probe missing or malformed Authorization header from ${req.socket?.remoteAddress ?? "unknown"}`,
      );
      respondUnauthorized(res, "Authorization: Bearer <token> required");
      return;
    }

    if (!validateToken(token, account.token)) {
      log?.warn(
        `[ai-nexus] health probe invalid token from ${req.socket?.remoteAddress ?? "unknown"}`,
      );
      respondUnauthorized(res, "Invalid token");
      return;
    }

    respondJson(res, 200, {
      ok: true,
      channel: "ai-nexus",
      accountId: account.accountId,
      enabled: account.enabled,
      signalrConnected: isAiNexusSignalrConnected(),
      ts: Date.now(),
    });
  };
}
