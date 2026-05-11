import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/** Constant-time token comparison to prevent timing attacks. */
export function validateToken(provided: string, expected: string): boolean {
  if (!expected) {
    return false;
  }
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return value ?? "";
}

/**
 * Extract the token from an `Authorization: Bearer <token>` header.
 *
 * Returns the raw token string if the scheme is Bearer, or undefined if the
 * header is missing, empty, uses a different scheme, or has an empty value.
 */
export function extractBearerToken(req: IncomingMessage): string | undefined {
  const raw = headerValue(req.headers.authorization).trim();
  if (!raw) {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/i.exec(raw);
  if (!match) {
    return undefined;
  }
  const token = match[1]?.trim() ?? "";
  return token || undefined;
}
