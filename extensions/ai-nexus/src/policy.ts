export type AiNexusDmPolicy = "open" | "allowlist" | "disabled";

export type SenderAuthResult = {
  allowed: boolean;
  reason?: string;
};

export function normalizeAiNexusHandle(value: string): string {
  return value.trim().replace(/^ai[-_]?nexus:/i, "");
}

export function isAiNexusSenderAllowed(
  senderId: string,
  dmPolicy: AiNexusDmPolicy,
  allowedSenderIds: string[],
): SenderAuthResult {
  if (dmPolicy === "disabled") {
    return { allowed: false, reason: "disabled" };
  }
  if (dmPolicy === "open") {
    return { allowed: true };
  }
  if (allowedSenderIds.length === 0) {
    return { allowed: false, reason: "allowlist-empty" };
  }
  const normalized = senderId.toLowerCase().trim();
  const found = allowedSenderIds.some((id) => id.toLowerCase().trim() === normalized);
  return found ? { allowed: true } : { allowed: false, reason: "not-allowed" };
}
