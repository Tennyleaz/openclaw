// oxlint-disable no-unused-vars
import {
  buildApprovalPendingReplyPayload,
  createApproverRestrictedNativeApprovalCapability,
  resolveExecApprovalCommandDisplay,
  resolveExecApprovalRequestAllowedDecisions,
} from "openclaw/plugin-sdk/approval-runtime";
import { getExecApprovalReplyMetadata } from "openclaw/plugin-sdk/approval-runtime";
import { ChannelApprovalCapability } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { listAccountIds, resolveAccount } from "./accounts.js";

export function resolveAiNexusExecApprovalConfig(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean | undefined {
  return resolveAccount(params).execApprovals;
}

export function isAiNexusExecApprovalEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  return resolveAiNexusExecApprovalConfig(params) ?? false;
}

export function resolveAiNexusExecApprovalTarget(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): "dm" | "channel" | "both" {
  // TODO: make this adjustable
  return "dm";
}

export function getAiNexusExecApprovalApprovers(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string[] {
  if (params.accountId) {
    return [params.accountId];
  }
  return [];
}

export function isAiNexusExecApprovalAuthorizedSender(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  senderId?: string | null;
}): boolean {
  // All senders on this channel are authorized to trigger exec approval.
  // The approval itself is still gated by isAiNexusExecApprovalApprover.
  return true;
}

export function isAiNexusExecApprovalApprover(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  senderId?: string | null;
}): boolean {
  const senderId = params.senderId?.trim();
  if (!senderId) {
    return false;
  }
  const approvers = getAiNexusExecApprovalApprovers(params);
  return approvers.includes(senderId);
}

export function shouldSuppressAiNexusExecApprovalPrompt(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  payload: ReplyPayload;
}): boolean {
  void params.cfg;
  void params.accountId;
  return getExecApprovalReplyMetadata(params.payload) !== null;
}

export const aiNexusExecApprovalAdapter: ChannelApprovalCapability = {
  ...createApproverRestrictedNativeApprovalCapability({
    channel: "ai-nexus",
    channelLabel: "AI Nexus",
    listAccountIds: listAccountIds,
    hasApprovers: ({ cfg, accountId }) =>
      getAiNexusExecApprovalApprovers({ cfg, accountId }).length > 0,
    isExecAuthorizedSender: ({ cfg, accountId, senderId }) =>
      isAiNexusExecApprovalAuthorizedSender({ cfg, accountId, senderId }),
    isPluginAuthorizedSender: ({ cfg, accountId, senderId }) =>
      isAiNexusExecApprovalApprover({ cfg, accountId, senderId }),
    isNativeDeliveryEnabled: () => false,
    resolveNativeDeliveryMode: ({ cfg, accountId }) =>
      resolveAiNexusExecApprovalTarget({ cfg, accountId }),
    requireMatchingTurnSourceChannel: true,
    resolveSuppressionAccountId: ({ target, request }) =>
      target.accountId?.trim() || request.request.turnSourceAccountId?.trim() || undefined,
    describeExecApprovalSetup: ({ accountId }) => {
      const base =
        accountId && accountId !== "default"
          ? `channels.ai-nexus.accounts.${accountId}`
          : `channels.ai-nexus`;
      return `To enable exec approvals, set \`${base}.execApprovals\` to true in your config.`;
    },
  }),
  // Override initiating surface state independently from isNativeDeliveryEnabled.
  // sendPayload handles exec approval delivery via the external server, so
  // native delivery stays off while the surface reports "enabled" to prevent
  // core from emitting the "not configured" warning text.
  getExecInitiatingSurfaceState: ({
    cfg,
    accountId,
  }: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    action: "approve";
  }) => {
    const account = resolveAccount(cfg, accountId);
    return account.execApprovals ? ({ kind: "enabled" } as const) : ({ kind: "disabled" } as const);
  },
  // Render custom exec approval message so we don't get plain text from default buildRequestMessage() method.
  render: {
    exec: {
      buildPendingPayload: ({ request, nowMs }) => {
        const commandDisplay = resolveExecApprovalCommandDisplay(request.request);
        const allowedDecisions = resolveExecApprovalRequestAllowedDecisions(request.request);
        const approvalData = {
          command: commandDisplay.commandText,
          cwd: request.request.cwd ?? undefined,
          host: request.request.host === "node" ? "node" : "gateway",
          nodeId: request.request.nodeId ?? undefined,
          agentId: request.request.agentId ?? undefined,
          allowedDecisions,
          expiresAtMs: request.expiresAtMs,
        };
        // in sendPayload callback, param.payload.text will be this object
        return buildApprovalPendingReplyPayload({
          approvalId: request.id,
          approvalSlug: request.id.slice(0, 8),
          text: JSON.stringify(approvalData),
          agentId: request.request.agentId,
          allowedDecisions,
          sessionKey: request.request.sessionKey,
          channelData: { aiNexusApproval: approvalData },
        });
      },
    },
  },
};
