// oxlint-disable no-unused-vars
//import { log } from "node:console";
import type { ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk/core";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/routing";
import { registerPluginHttpRoute } from "openclaw/plugin-sdk/webhook-ingress";
import { listAccountIds, resolveAccount } from "./accounts.js";
import {
  getAiNexusSignalrContext,
  setAiNexusSignalrContext,
  sendExecApproval,
  sendMediaFile,
  sendMessage,
  setAiNexusSignalrMessageHandler,
  startSignalrClient,
  stopSignalrClient,
} from "./client.ts";
import { AiNexusConfigSchema } from "./config-schema.js";
import {
  aiNexusExecApprovalAdapter,
  shouldSuppressAiNexusExecApprovalPrompt,
} from "./exec-approvals.js";
import { createHealthHandler } from "./health-handler.js";
import { activeMediaCollectors, resolveMediaItem } from "./media.js";
import { isAiNexusSenderAllowed, normalizeAiNexusHandle } from "./policy.js";
//import * as monitorModule from "./monitor.js";
import { getAiNexusRuntime } from "./runtime.js";
import type { MediaItem, ResolvedAiNexusAccount, DeliverEvent, DeliverMessage, MediaCollector } from "./types.js";
import { createWebhookHandler, forwardSignalrEvent } from "./webhook-handler.js";

const CHANNEL_ID = "ai-nexus";

const activeRouteUnregisters = new Map<string, () => void>();

function waitUntilAbort(signal?: AbortSignal, onAbort?: () => void): Promise<void> {
  return new Promise((resolve) => {
    const complete = () => {
      onAbort?.();
      resolve();
    };
    if (!signal) {
      return;
    }
    if (signal.aborted) {
      complete();
      return;
    }
    signal.addEventListener("abort", complete, { once: true });
  });
}

// function resolveTAiNexusMonitor() {
//   return monitorModule.monitorAiNexusProvider;
// }

function createInboundDeliverer(
  account: ResolvedAiNexusAccount,
  log?: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
  },
) {
  return async (msg: DeliverMessage, onEvent?: (event: DeliverEvent) => void) => {
    const rt = getAiNexusRuntime();
    const currentCfg = rt.config.loadConfig();

    const replyParts: string[] = [];
    const mediaItems: MediaItem[] = [];

    const collectorKey = msg.from;
    const collector: MediaCollector = { items: [], onEvent: onEvent ?? undefined };
    activeMediaCollectors.set(collectorKey, collector);

    try {
      const msgCtx = rt.channel.reply.finalizeInboundContext({
        Body: msg.body,
        RawBody: msg.body,
        CommandBody: msg.body,
        From: `ai-nexus:${msg.from}`,
        To: `ai-nexus:${msg.from}`,
        SessionKey: msg.sessionKey,
        AccountId: account.accountId,
        OriginatingChannel: CHANNEL_ID,
        OriginatingTo: `ai-nexus:${msg.from}`,
        ChatType: msg.chatType,
        SenderName: msg.senderName,
        SenderId: msg.from,
        Provider: CHANNEL_ID,
        Surface: CHANNEL_ID,
        ConversationLabel: msg.senderName || msg.from,
        Timestamp: Date.now(),
        CommandAuthorized: true,
      });

      await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: msgCtx,
        cfg: currentCfg,
        dispatcherOptions: {
          deliver: async (
            payload: {
              text?: string;
              body?: string;
              mediaUrl?: string;
              mediaUrls?: string[];
            },
            info,
          ) => {
            log?.info?.(`[ai-nexus] deliver kind: ${info.kind}`);
            //log?.info?.(`[ai-nexus] onEvent is: ${onEvent}`);
            const text = payload?.text ?? payload?.body;
            if (text) {
              replyParts.push(text);
              if (info.kind === "tool") {
                onEvent?.({ type: "tool", toolName: text });
                log?.info?.(`[ai-nexus] Tool call to ${msg.from}: ${text.slice(0, 100)}`);
              } else {
                onEvent?.({ type: "text", text });
                log?.info?.(`[ai-nexus] Reply to ${msg.from}: ${text.slice(0, 100)}`);
              }
            }

            const urls = payload?.mediaUrls ?? (payload?.mediaUrl ? [payload.mediaUrl] : []);
            for (const rawUrl of urls) {
              if (!rawUrl) {
                continue;
              }
              const item = await resolveMediaItem(rawUrl);
              mediaItems.push(item);
              onEvent?.({ type: "media", url: item.url, contentType: item.contentType });
              log?.info?.(`[ai-nexus] Media to ${msg.from}: ${rawUrl.slice(0, 120)}`);
            }
          },
          onReplyStart: () => {
            // This is typing indicator event. If set suppressTyping=true, this event will not fire.
            log?.info?.(`Agent reply started for ${msg.from}`);
          },
          humanDelay: {
            mode: "natural",
          },
        },
        replyOptions: {
          suppressTyping: true,
          onToolStart: (payload) => {
            // payload.name is the tool's name. Ex: message, exec, browser, etc.
            if (payload.name && payload.name !== "message") {
              log?.info?.(`[ai-nexus] onToolStart: ${payload.name}`);
              // Tell non-message tool call to caller, by SSE or sendMessage
              onEvent?.({ type: "tool", toolName: payload.name });
            }
          },
          onToolResult: (payload) => {
            console.log("[ai-nexus] onToolResult:", payload);
          }
        },
      });

      return {
        text: replyParts,
        media: [...mediaItems, ...collector.items],
      };
    } finally {
      activeMediaCollectors.delete(collectorKey);
    }
  };
}

export const aiNexusPlugin: ChannelPlugin<ResolvedAiNexusAccount> = {
  id: CHANNEL_ID,

  meta: {
    id: CHANNEL_ID,
    label: "AI Nexus",
    selectionLabel: "AI Nexus (Webhook)",
    detailLabel: "AI Nexus (Webhook)",
    docsPath: "/channels/ai-nexus",
    blurb: "Receive text messages via HTTP webhook and forward them to the OpenClaw agent.",
    order: 95,
  },

  capabilities: {
    chatTypes: ["direct"],
    media: true,
    threads: false,
    reactions: false,
    edit: false,
    unsend: false,
    reply: false,
    effects: false,
    blockStreaming: false,
  },

  reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },

  configSchema: AiNexusConfigSchema,

  config: {
    listAccountIds: (cfg) => listAccountIds(cfg),

    resolveAccount: (cfg, accountId) => resolveAccount(cfg, accountId),

    defaultAccountId: () => DEFAULT_ACCOUNT_ID,

    setAccountEnabled: ({ cfg, accountId, enabled }) => {
      const channelConfig = (cfg as Record<string, unknown>).channels as
        | Record<string, unknown>
        | undefined;
      const aiNexusCfg = channelConfig?.[CHANNEL_ID] ?? {};
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            [CHANNEL_ID]: { ...(aiNexusCfg as Record<string, unknown>), enabled },
          },
        };
      }
      // Default we return a OpenClawConfig, don't call setAccountEnabledInConfigSection because it cannot import
      const myConfig = cfg.channels?.[CHANNEL_ID] as OpenClawConfig | undefined;
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          [CHANNEL_ID]: {
            ...myConfig,
          },
        },
      };
    },
  },

  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const channelCfg = (cfg as Record<string, unknown>).channels as
        | Record<string, Record<string, unknown>>
        | undefined;
      const nexusCfg = channelCfg?.[CHANNEL_ID] as
        | { accounts?: Record<string, unknown> }
        | undefined;
      const useAccountPath = Boolean(nexusCfg?.accounts?.[resolvedAccountId]);
      const basePath = useAccountPath
        ? `channels.${CHANNEL_ID}.accounts.${resolvedAccountId}.`
        : `channels.${CHANNEL_ID}.`;
      return {
        policy: account.dmPolicy ?? "open",
        allowFrom: account.allowedSenderIds ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: `openclaw pairing approve ${CHANNEL_ID} <code>`,
        normalizeEntry: (raw: string) => raw.toLowerCase().trim(),
      };
    },
    collectWarnings: ({ account }) => {
      const warnings: string[] = [];
      if (!account.token) {
        warnings.push("- AI Nexus: token is not configured. The webhook will reject all requests.");
      }
      if (account.dmPolicy === "allowlist" && account.allowedSenderIds.length === 0) {
        warnings.push(
          '- AI Nexus: dmPolicy="allowlist" with empty allowedSenderIds blocks all senders. Add senders or set dmPolicy="open".',
        );
      }
      return warnings;
    },
  },

  messaging: {
    normalizeTarget: (target) => {
      const normalized = normalizeAiNexusHandle(target);
      return normalized || undefined;
    },
    targetResolver: {
      looksLikeId: (id) => {
        const trimmed = id?.trim();
        if (!trimmed) {
          return false;
        }
        return /^ai[-_]?nexus:/i.test(trimmed) || trimmed.length > 0;
      },
      hint: "<senderId>",
    },
  },

  directory: {
    self: async () => null,
    listPeers: async () => [],
    listGroups: async () => [],
  },

  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4096,

    sendText: async ({ to, text, threadId, accountId }) => {
      const rt = getAiNexusRuntime();
      rt.logging
        .getChildLogger()
        .info(`[ai-nexus] outbound to ${to}, threadId ${threadId}: ${text.slice(0, 100)}`);
      if (text) {
        const signalrContext = getAiNexusSignalrContext(accountId ?? DEFAULT_ACCOUNT_ID, to);
        if (!signalrContext?.groupId || !signalrContext.token || !signalrContext.threadId) {
          rt.logging
            .getChildLogger()
            .warn("[ai-nexus] sendText skipped because no signalr groupId, token, or threadId.");
        } else {
          await sendMessage(
            "text",
            text,
            signalrContext.token,
            signalrContext.groupId,
            signalrContext.threadId,
          );
        }
      }
      return { channel: CHANNEL_ID, messageId: `ainx-${Date.now()}`, chatId: to };
    },

    sendMedia: async ({ to, text, mediaUrl, mediaLocalRoots, accountId }) => {
      const rt = getAiNexusRuntime();
      rt.logging
        .getChildLogger()
        .info(`[ai-nexus] outbound media to ${to}: ${mediaUrl?.slice(0, 120)}`);
      const collector = activeMediaCollectors.get(to);
      if (collector && mediaUrl) {
        const item = await resolveMediaItem(mediaUrl, mediaLocalRoots);
        collector.items.push(item);
        collector.onEvent?.({
          type: "media",
          url: item.url,
          dataUrl: item.dataUrl,
          contentType: item.contentType,
        });
      }
      if (collector && text) {
        collector.onEvent?.({ type: "text", text: text });
      }
      const signalrContext = getAiNexusSignalrContext(accountId ?? DEFAULT_ACCOUNT_ID, to);
      if (text && signalrContext?.groupId && signalrContext.token && signalrContext.threadId) {
        await sendMessage(
          "text",
          text,
          signalrContext.token,
          signalrContext.groupId,
          signalrContext.threadId,
        );
      }
      if (mediaUrl && signalrContext?.groupId && signalrContext.token && signalrContext.threadId) {
        await sendMediaFile(
          mediaUrl,
          signalrContext.token,
          signalrContext.groupId,
          signalrContext.threadId,
        );
      } else if (
        mediaUrl &&
        (!signalrContext?.groupId || !signalrContext.token || !signalrContext.threadId)
      ) {
        rt.logging
          .getChildLogger()
          .warn("[ai-nexus] sendMedia skipped media callback because no signalr groupId or token.");
      }
      return { channel: CHANNEL_ID, messageId: `ainx-${Date.now()}`, chatId: to };
    },

    sendPayload: async (param) => {
      const rt = getAiNexusRuntime();
      const execApproval = param.payload.channelData?.execApproval;
      if (!execApproval || typeof execApproval !== "object" || Array.isArray(execApproval)) {
        rt.logging
          .getChildLogger()
          .info("[ai-nexus] sendPayload skipped because not execApproval kind.");
        return { channel: CHANNEL_ID, messageId: "empty" };
      }
      const record = execApproval as Record<string, unknown>;
      if (record.state !== "pending") {
        return { channel: CHANNEL_ID, messageId: "empty" };
      }
      const approvalId =
        typeof record.approvalId === "string" ? record.approvalId.trim() : undefined;
      // payload.text is the JSON-stringified approval data from our render hook;
      // pass it through as-is so the frontend can deserialize the structured object.
      const command = param.payload.text ?? "";
      console.log("exec approval param.payload.channelData:", param.payload.channelData);
      console.log("exec approval param.text:", param.text);
      const runtimeContext =
        param.accountId && param.to
          ? getAiNexusSignalrContext(param.accountId, param.to)
          : undefined;
      const groupId = runtimeContext?.groupId;
      const token = runtimeContext?.token;
      const threadId = runtimeContext?.threadId;
      if (!approvalId || !groupId || !token || !threadId) {
        rt.logging
          .getChildLogger()
          .info("[ai-nexus] sendPayload skipped because no approvalId, groupId, token, or threadId.");
        return { channel: CHANNEL_ID, messageId: "empty" };
      }
      const messageId = await sendExecApproval(approvalId, command, token, groupId, threadId);
      if (messageId) {
        rt.logging
          .getChildLogger()
          .info("[ai-nexus] sendExecApproval success with message id: " + messageId);
        return { channel: CHANNEL_ID, messageId };
      }
      return { channel: CHANNEL_ID, messageId: "empty" };
    },

    shouldSuppressLocalPayloadPrompt: (params) => shouldSuppressAiNexusExecApprovalPrompt(params),

    beforeDeliverPayload: async ({ cfg, target, hint }) => {
      console.log(`beforeDeliverPayload hint=`, hint);
    },
  },

  gateway: {
    startAccount: async (ctx) => {
      const { cfg, accountId, log, account } = ctx;

      if (!account.enabled) {
        log?.info?.(`AI Nexus account ${accountId} is disabled, skipping`);
        return waitUntilAbort(ctx.abortSignal);
      }

      if (!account.token) {
        log?.warn?.(`AI Nexus account ${accountId} not configured (missing token)`);
        return waitUntilAbort(ctx.abortSignal);
      }

      if (account.dmPolicy === "allowlist" && account.allowedSenderIds.length === 0) {
        log?.warn?.(
          `AI Nexus account ${accountId} has dmPolicy=allowlist but empty allowedSenderIds; refusing to start`,
        );
        return waitUntilAbort(ctx.abortSignal);
      }

      log?.info?.(
        `Starting AI Nexus channel (account: ${accountId}, path: ${account.webhookPath})`,
      );

      const deliverInboundMessage = createInboundDeliverer(account, log);

      const handler = createWebhookHandler({
        account,
        deliver: deliverInboundMessage,
        log: log
          ? {
              info: (...args: unknown[]) => log.info?.(args.map(String).join(" ")),
              warn: (...args: unknown[]) => log.warn?.(args.map(String).join(" ")),
              error: (...args: unknown[]) => log.error?.(args.map(String).join(" ")),
            }
          : undefined,
      });

      const healthPath = `${account.webhookPath.replace(/\/+$/, "")}/health`;

      const routeKey = `${accountId}:${account.webhookPath}`;
      const prevUnregister = activeRouteUnregisters.get(routeKey);
      if (prevUnregister) {
        log?.info?.(`Deregistering stale route before re-registering: ${account.webhookPath}`);
        prevUnregister();
        activeRouteUnregisters.delete(routeKey);
      }

      const unregisterWebhook = registerPluginHttpRoute({
        path: account.webhookPath,
        auth: "plugin",
        replaceExisting: true,
        pluginId: CHANNEL_ID,
        accountId: account.accountId,
        log: (msg: string) => log?.info?.(msg),
        handler,
      });

      const unregisterHealth = registerPluginHttpRoute({
        path: healthPath,
        auth: "plugin",
        replaceExisting: true,
        pluginId: CHANNEL_ID,
        accountId: account.accountId,
        log: (msg: string) => log?.info?.(msg),
        handler: createHealthHandler({
          account,
          log: log
            ? {
                info: (...args: unknown[]) => log.info?.(args.map(String).join(" ")),
                warn: (...args: unknown[]) => log.warn?.(args.map(String).join(" ")),
                error: (...args: unknown[]) => log.error?.(args.map(String).join(" ")),
              }
            : undefined,
        }),
      });

      const unregister = () => {
        unregisterHealth();
        unregisterWebhook();
      };
      activeRouteUnregisters.set(routeKey, unregister);

      log?.info?.(`Registered HTTP route: ${account.webhookPath} for AI Nexus`);
      log?.info?.(`Registered HTTP route: ${healthPath} for AI Nexus health probe`);

      const isSignalrDefaultAccount = account.accountId === DEFAULT_ACCOUNT_ID;
      if (isSignalrDefaultAccount) {
        setAiNexusSignalrMessageHandler(async (signalrMessage) => {
          if (signalrMessage.kind !== "text" || !signalrMessage.text) {
            return;
          }

          const auth = isAiNexusSenderAllowed(
            signalrMessage.senderId,
            account.dmPolicy,
            account.allowedSenderIds,
          );
          if (!auth.allowed) {
            log?.warn?.(
              `[ai-nexus] Rejecting SignalR sender ${signalrMessage.senderId} (${auth.reason ?? "unknown"})`,
            );
            return;
          }
          setAiNexusSignalrContext(DEFAULT_ACCOUNT_ID, signalrMessage.senderId, {
            groupId: signalrMessage.groupId,
            token: signalrMessage.token,
            threadId: signalrMessage.threadId,
          });

          const callbackContext =
            signalrMessage.groupId && signalrMessage.token && signalrMessage.threadId
              ? {
                  groupId: signalrMessage.groupId,
                  token: signalrMessage.token,
                  threadId: signalrMessage.threadId,
                }
              : undefined;
          let warnedMissingCallbackContext = false;
          await deliverInboundMessage(
            {
              body: signalrMessage.text,
              from: signalrMessage.senderId,
              senderName: signalrMessage.senderId,
              provider: CHANNEL_ID,
              chatType: "direct",
              sessionKey: `ai-nexus-${signalrMessage.senderId}`,
              accountId: DEFAULT_ACCOUNT_ID,
            },
            (event) => {
              if (!callbackContext) {
                if (!warnedMissingCallbackContext) {
                  warnedMissingCallbackContext = true;
                  log?.warn?.(
                    `[ai-nexus] SignalR inbound reply skipped: missing callback token/group for ${signalrMessage.senderId}`,
                  );
                }
                return;
              }
              void forwardSignalrEvent(event, callbackContext, {
                warn: (...args: unknown[]) => log?.warn?.(args.map(String).join(" ")),
              });
            },
          );
        });

        const startedSignalr = await startSignalrClient();
        if (!startedSignalr) {
          log?.warn?.("[ai-nexus] SignalR client failed to start.");
        } else {
          log?.info?.("[ai-nexus] SignalR client started.");
        }
      }

      // resolveTAiNexusMonitor()({
      //   token: "a",
      //   accountId: account.accountId,
      //   config: ctx.cfg,
      //   runtime: ctx.runtime,
      // });

      // log?.info?.(`Started AI Nexus monitor`);

      return waitUntilAbort(ctx.abortSignal, () => {
        log?.info?.(`Stopping AI Nexus channel (account: ${accountId})`);
        if (typeof unregister === "function") {
          unregister();
        }
        activeRouteUnregisters.delete(routeKey);
        if (isSignalrDefaultAccount) {
          setAiNexusSignalrMessageHandler(undefined);
          void stopSignalrClient().catch((error) => {
            log?.warn?.(`[ai-nexus] Failed to stop SignalR client: ${String(error)}`);
          });
        }
      });
    },

    stopAccount: async (ctx) => {
      ctx.log?.info?.(`AI Nexus account ${ctx.accountId} stopped`);
    },
  },
  approvalCapability: aiNexusExecApprovalAdapter,
};

// function hasAiNexusExecApprovalDmRoute(cfg: OpenClawConfig): boolean {
//   return listAccountIds(cfg).some((accountId) => {
//     if (!isAiNexusExecApprovalEnabled({ cfg, accountId })) {
//       return false;
//     }
//     const target = resolveAiNexusExecApprovalTarget({ cfg, accountId });
//     return target === "dm" || target === "both";
//   });
// }
