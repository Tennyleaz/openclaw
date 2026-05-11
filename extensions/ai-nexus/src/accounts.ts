// oxlint-disable typescript/no-explicit-any
import type { AiNexusChannelConfig, ResolvedAiNexusAccount } from "./types.js";

function getChannelConfig(cfg: any): AiNexusChannelConfig | undefined {
  return cfg?.channels?.["ai-nexus"];
}

function parseAllowedSenderIds(raw: string | string[] | undefined): string[] {
  if (!raw) {
    return [];
  }
  if (Array.isArray(raw)) {
    return raw.filter(Boolean);
  }
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * List all configured account IDs for this channel.
 * Returns ["default"] if base config has a token, plus any named accounts.
 */
export function listAccountIds(cfg: any): string[] {
  const channelCfg = getChannelConfig(cfg);
  if (!channelCfg) {
    return [];
  }

  const ids = new Set<string>();

  if (channelCfg.token || process.env.AINEXUS_TOKEN) {
    ids.add("default");
  }

  if (channelCfg.accounts) {
    for (const id of Object.keys(channelCfg.accounts)) {
      ids.add(id);
    }
  }

  return Array.from(ids);
}

/**
 * Resolve a specific account by ID with full defaults applied.
 * Falls back to env vars for the "default" account.
 */
export function resolveAccount(cfg: any, accountId?: string | null): ResolvedAiNexusAccount {
  const channelCfg = getChannelConfig(cfg) ?? {};
  const id = accountId || "default";

  const accountOverride = channelCfg.accounts?.[id] ?? {};

  const envToken = process.env.AINEXUS_TOKEN ?? "";

  return {
    accountId: id,
    enabled: accountOverride.enabled ?? channelCfg.enabled ?? true,
    token: accountOverride.token ?? channelCfg.token ?? envToken,
    webhookPath: accountOverride.webhookPath ?? channelCfg.webhookPath ?? "/webhook/ai-nexus",
    dmPolicy: accountOverride.dmPolicy ?? channelCfg.dmPolicy ?? "open",
    allowedSenderIds: parseAllowedSenderIds(
      accountOverride.allowedSenderIds ?? channelCfg.allowedSenderIds,
    ),
    execApprovals: accountOverride.execApprovals ?? channelCfg.execApprovals ?? true,
  };
}
