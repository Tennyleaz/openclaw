//import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
//import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";

/** Raw channel config from openclaw.json channels.ai-nexus */
export interface AiNexusChannelConfig {
  enabled?: boolean;
  token?: string;
  webhookPath?: string;
  dmPolicy?: "open" | "allowlist" | "disabled";
  allowedSenderIds?: string | string[];
  execApprovals?: boolean;
  aiNexusApiKey?: string;
  accounts?: Record<string, AiNexusAccountRaw>;
}

/** Raw per-account config (overrides base config) */
export interface AiNexusAccountRaw {
  enabled?: boolean;
  token?: string;
  webhookPath?: string;
  dmPolicy?: "open" | "allowlist" | "disabled";
  allowedSenderIds?: string | string[];
  execApprovals?: boolean;
}

/** Fully resolved account config with defaults applied */
export interface ResolvedAiNexusAccount {
  accountId: string;
  enabled: boolean;
  token: string;
  webhookPath: string;
  dmPolicy: "open" | "allowlist" | "disabled";
  allowedSenderIds: string[];
  execApprovals: boolean;
}

/** A media item included in the agent's reply (URL-based). */
export interface MediaItem {
  url: string;
  dataUrl?: string;
  contentType?: string;
}

/** Result returned from the deliver callback, containing text and any media. */
export interface DeliverResult {
  text: string[];
  media: MediaItem[];
}

/** Inbound webhook POST body */
export interface AiNexusWebhookPayload {
  /** Inbound webhook auth token for this channel/account. */
  webhookToken: string;
  senderId: string;
  text: string;
  senderName?: string;
  /** Hold the connection open and return the full agent reply as JSON. */
  sync?: boolean;
  /** Stream reply chunks back as SSE events (text/event-stream). */
  stream?: boolean;
  /** Send POST message to signalr server if this group id has value. */
  signalrGroupId?: string;
  /** Bearer token used for outbound SignalR callback POST requests. */
  signalrToken?: string;
}

export interface SendMessageRequest {
  messageId: string;
  kind: "text" | "file" | "tool" | "approval";
  text?: string;
  fileId?: string;
}

/** Message from signalr onMessage event */
export interface MessageDto {
  messageId: string;
  groupId: string;
  senderId: string;
  kind: "text" | "file" | "tool" | "approval";
  text?: string;
  fileId?: string;
  createdAtUtc: string;
}

/** Object for webhook's internl deliver event */
export interface DeliverMessage {
  body: string;
  from: string;
  senderName: string;
  provider: string;
  chatType: string;
  // "ai-nexus-" + sender's account id
  sessionKey: string;
  // sender's account id
  accountId: string;
}

export type DeliverEvent =
  | { type: "text"; text: string }
  | { type: "tool"; toolName: string }
  | { type: "approval"; approvalId: string; command: string }
  | { type: "media"; url: string; dataUrl?: string; contentType?: string };

export interface WebhookHandlerDeps {
  account: ResolvedAiNexusAccount;
  deliver: (msg: DeliverMessage, onEvent?: (event: DeliverEvent) => void) => Promise<DeliverResult>;
  log?: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}

/** Group id and token, which is recorded in a map or from environment variable. */
export type AiNexusSignalRContext = {
  groupId?: string;
  token?: string;
};

export type AiNexusSignalrInboundMessage = {
  messageId: string;
  groupId: string;
  senderId: string;
  kind: "text" | "file" | "tool" | "approval";
  text?: string;
  fileId?: string;
  token?: string;
};

export interface MediaCollector {
  items: MediaItem[];
  onEvent?: (event: DeliverEvent) => void;
}

// export type MonitorAiNexusOpts = {
//   token?: string;
//   accountId?: string;
//   config?: OpenClawConfig;
//   runtime?: RuntimeEnv;
// };

// export type AiNexusExecApprovalHandlerOption = {
//   token: string;
//   accountId: string;
//   cfg: OpenClawConfig;
//   gatewayUrl?: string;
//   runtime?: RuntimeEnv;
// };

// export type AiNexusExecApprovalHandlerDeps = {
//   nowMs?: () => number;
//   sendMessageCallback?: (
//     approvalId: string,
//     command: string,
//     token: string,
//     groupId: string | undefined,
//   ) => Promise<string | undefined>;
// };
