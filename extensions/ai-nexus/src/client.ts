import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as signalR from "@microsoft/signalr";
import { isDataUrl, isFileUrl, isHttpUrl } from "./media-utils.js";
import { uploadFile } from "./external-api.js";
import { normalizeAiNexusHandle } from "./policy.js";
import { getAiNexusApiKey } from "./runtime.js";
import type {
  AiNexusSignalRContext,
  AiNexusSignalrInboundMessage,
  MessageDto,
  SendMessageRequest,
} from "./types.js";

const BASE_URL = process.env.AINEXUS_SIGNALR_URL?.trim() || "http://192.168.41.173:5246";

async function postSignalrPayload(
  groupId: string,
  token: string,
  body: SendMessageRequest,
): Promise<Response | undefined> {
  const url = BASE_URL + `/groups/${groupId}/messages`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    console.log(`postSignalrPayload to group ${groupId} result=${response.status}`);
    return response;
  } catch (error) {
    console.error(error);
    return undefined;
  }
}

async function postSignalrMessage(
  groupId: string,
  token: string,
  body: SendMessageRequest,
): Promise<boolean> {
  const response = await postSignalrPayload(groupId, token, body);
  return response?.ok ?? false;
}

const aiNexusSignalRContext = new Map<string, AiNexusSignalRContext>();

function normalizeSignalRId(value: string): string {
  return value.trim();
}

function buildSignalRContextKey(accountId: string, senderId: string, groupId?: string, threadId?: string): string {
  const parts = [
    normalizeSignalRId(accountId),
    normalizeAiNexusHandle(senderId),
    groupId?.trim() ?? "",
    threadId?.trim() ?? "",
  ];
  return parts.join(":");
}

/**
 * Remember an account's last used signalr groupId and token in a map.
 * @param accountId 
 * @param senderId 
 * @param context 
 * @returns 
 */
export function setAiNexusSignalrContext(
  accountId: string,
  senderId: string,
  context: AiNexusSignalRContext,
): void {
  const normalizedAccountId = normalizeSignalRId(accountId);
  const normalizedSenderId = normalizeAiNexusHandle(senderId);
  const key = buildSignalRContextKey(
    normalizedAccountId,
    normalizedSenderId,
    context.groupId,
    context.threadId,
  );
  const normalizedContext: AiNexusSignalRContext = {
    groupId: context.groupId?.trim(),
    token: context.token?.trim(),
    threadId: context.threadId?.trim(),
  };

  if (!normalizedContext.groupId && !normalizedContext.token && !normalizedContext.threadId) {
    aiNexusSignalRContext.delete(key);
    return;
  }

  aiNexusSignalRContext.set(key, normalizedContext);
}

/**
 * Try to get signalr group id and token, from past map or environment variables.
 * @param accountId
 * @param senderId
 * @returns
 */
export function getAiNexusSignalrContext(
  accountId: string,
  senderId: string,
  groupId?: string,
  threadId?: string,
): AiNexusSignalRContext | undefined {
  const key = buildSignalRContextKey(accountId, senderId, groupId, threadId);
  const value = aiNexusSignalRContext.get(key);
  if (value) {
    return value;
  }

  // Fallback: match the latest context for this sender when thread id is omitted.
  if (!threadId) {
    const prefix = `${normalizeSignalRId(accountId)}:${normalizeAiNexusHandle(senderId)}:`;
    for (const [mapKey, mapValue] of [...aiNexusSignalRContext.entries()].reverse()) {
      if (mapKey.startsWith(prefix)) {
        return mapValue;
      }
    }
  }
  // Also try get group id and token from environment variables.
  const signalrGroupId = process.env.AINEXUS_SIGNALR_GROUP_ID;
  const signalrToken = process.env.AINEXUS_SIGNALR_TOKEN;
  if (signalrGroupId && signalrToken) {
    return {
      groupId: signalrGroupId,
      token: signalrToken,
    };
  }
  return undefined;
}

export async function sendMessage(
  type: "text" | "tool",
  text: string,
  token: string,
  groupId: string,
  threadId: string,
): Promise<boolean> {
  const body: SendMessageRequest = {
    messageId: crypto.randomUUID(),
    threadId,
    kind: type,
    text: text,
  };

  return await postSignalrMessage(groupId, token, body);
}

export async function sendMediaFile(
  fileUrl: string,
  token: string,
  groupId: string,
  threadId: string,
): Promise<boolean> {
  const apiKey = getAiNexusApiKey();
  if (!apiKey) {
    const error: string = "sendMediaFile cannot find AINEXUS_API_KEY in runtime or environment variables.";
    console.error(error);
    return false;
  }

  const trimmedFileUrl = fileUrl.trim();
  if (!trimmedFileUrl) {
    console.error(`sendMediaFile requires a non-empty file source, got: ${fileUrl}`);
    return false;
  }

  const fileIsHttpUrl = isHttpUrl(trimmedFileUrl);
  const fileIsDataUrl = isDataUrl(trimmedFileUrl);
  const fileIsFileUrl = isFileUrl(trimmedFileUrl);

  if (fileIsHttpUrl) {
    console.error(`sendMediaFile only accepts local file path or base64 data URL, got: ${fileUrl}`);
    return false;
  }

  const normalizedFile = async (): Promise<{ data: Buffer; fileName: string }> => {
    if (fileIsDataUrl) {
      const commaIndex = trimmedFileUrl.indexOf(",");
      if (commaIndex === -1) {
        throw new Error("Invalid data URL format.");
      }
      const metadata = trimmedFileUrl.slice(5, commaIndex);
      const encoded = trimmedFileUrl.slice(commaIndex + 1);
      const isBase64 = metadata.includes(";base64");
      const mimeMatch = /^([^;]+)/.exec(metadata);
      const mimeType = mimeMatch?.[1] ?? "application/octet-stream";
      const ext = (() => {
        switch (mimeType.toLowerCase()) {
          case "image/png":
            return ".png";
          case "image/jpeg":
            return ".jpg";
          case "image/webp":
            return ".webp";
          case "image/gif":
            return ".gif";
          case "text/plain":
            return ".txt";
          case "application/pdf":
            return ".pdf";
          default:
            return ".bin";
        }
      })();

      if (isBase64) {
        return { data: Buffer.from(encoded, "base64"), fileName: `media${ext}` };
      }
      return { data: Buffer.from(decodeURIComponent(encoded)), fileName: `media${ext}` };
    }

    const localFilePath = fileIsFileUrl ? fileURLToPath(trimmedFileUrl) : resolve(trimmedFileUrl);
    return { data: await readFile(localFilePath), fileName: basename(localFilePath) };
  };

  let fileId = "";
  try {
    const { data, fileName } = await normalizedFile();
    const file = new File([new Uint8Array(data)], fileName);
    const form = new FormData();
    form.append("file", file, fileName);
    form.append("description", "");
    form.append("isPublic", "false");

    const uploadResponse = await uploadFile(apiKey, form);

    if (!uploadResponse.ok) {
      const text = await uploadResponse.text();
      console.log(`sendMediaFile upload fail! status=${uploadResponse.status}`);
      console.log("upload response:", text);
      return false;
    }

    const uploadResult = await uploadResponse.json();
    const fileIdFromUpload =
      typeof uploadResult === "object" &&
        uploadResult !== null &&
        typeof (uploadResult as { data?: { fileId?: unknown } }).data === "object"
        ? (uploadResult as { data?: { fileId?: unknown } }).data?.fileId
        : undefined;

    if (typeof fileIdFromUpload === "string" && fileIdFromUpload.trim()) {
      fileId = fileIdFromUpload.trim();
    } else if (typeof fileIdFromUpload === "number") {
      fileId = String(fileIdFromUpload);
    }
  } catch (error) {
    console.error(error);
    return false;
  }

  if (!fileId) {
    console.error(`sendMediaFile failed to get fileId from upload response: ${fileUrl}`);
    return false;
  }

  const body: SendMessageRequest = {
    messageId: crypto.randomUUID(),
    threadId,
    kind: "file",
    fileId: fileId,
  };

  return await postSignalrMessage(groupId, token, body);
}

/**
 * Send exec approval to signalr server. Returns message id if success, undefined if fail.
 * @param approvalId
 * @param command
 * @param token
 * @param groupId
 * @returns
 */
export async function sendExecApproval(
  approvalId: string,
  command: string,
  token: string,
  groupId: string | undefined,
  threadId: string | undefined,
) {
  if (!groupId) {
    console.error("sendExecApproval has no groupId!");
    return undefined;
  }
  if (!threadId) {
    console.error("sendExecApproval has no threadId!");
    return undefined;
  }

  const approvalData = {
    approvalId,
    command,
  };
  const body: SendMessageRequest = {
    messageId: crypto.randomUUID(),
    threadId,
    kind: "approval",
    text: JSON.stringify(approvalData),
  };

  const response = await postSignalrPayload(groupId, token, body);
  if (response?.ok) {
    return body.messageId;
  }

  if (response) {
    const url = BASE_URL + `/groups/${groupId}/messages`;
    console.log(`sendExecApproval fail! url: ${url}, status=${response.status}`);
    console.log("request body:", body);
  }
  return undefined;
}

let connection: signalR.HubConnection | undefined = undefined;
let signalrMessageHandler:
  | ((message: AiNexusSignalrInboundMessage) => Promise<void> | void)
  | undefined;

/** Set the signalr onMessage event hander. Set undefined to remove handler. */
export function setAiNexusSignalrMessageHandler(
  handler: ((message: AiNexusSignalrInboundMessage) => Promise<void> | void) | undefined,
): void {
  signalrMessageHandler = handler;
}

export async function startSignalrClient(): Promise<boolean> {
  if (connection?.state === signalR.HubConnectionState.Connected) {
    return true;
  }

  const url = BASE_URL + "/hub/messages";
  try {
    if (!connection) {
      // Guard the environment variables
      const signalrToken = getSignalrToken();
      if (!signalrToken) {
        console.error("SignalR cannot get token in AINEXUS_SIGNALR_TOKEN.");
        return false;
      }
      if (!process.env.AINEXUS_SIGNALR_GROUP_ID) {
        console.error("SignalR cannot get group id in AINEXUS_SIGNALR_GROUP_ID.");
        return false;
      }
      connection = new signalR.HubConnectionBuilder()
        .withUrl(url, {
          accessTokenFactory: getSignalrToken,
          skipNegotiation: true,
          transport: signalR.HttpTransportType.WebSockets,
        })
        .withAutomaticReconnect()
        .build();
      connection.on("OnMessage", onServerMessage);
      connection.onclose((error) => {
        console.log("SignalR connection closed", error);
      });
      connection.onreconnected((id) => {
        console.log("SignalR reconnected:", id);
      });
    }

    if (connection.state !== signalR.HubConnectionState.Connected) {
      await connection.start();
    }
    console.log("SignalR connected:", connection.connectionId);
    return true;
  } catch (error) {
    console.error("Error starting SignalR client:", error);
    return false;
  }
}

export async function stopSignalrClient() {
  if (connection) {
    await connection.stop();
    connection = undefined;
  }
}

/**
 * Returns true when a SignalR connection object exists and is in the
 * Connected state. Used by the health endpoint to report inbound-SignalR
 * reachability without exposing the underlying connection.
 */
export function isAiNexusSignalrConnected(): boolean {
  return connection?.state === signalR.HubConnectionState.Connected;
}

/** Read AINEXUS_SIGNALR_TOKEN, which is the signalr sender id (openclaw-xxxxxx). */
function getSignalrToken(): string {
  const signalrToken = process.env.AINEXUS_SIGNALR_TOKEN;
  return signalrToken ?? "";
}

function normalizeInboundMessage(dto: MessageDto): AiNexusSignalrInboundMessage | undefined {
  const senderId = dto?.senderId?.trim();
  const groupId = dto?.groupId?.trim();
  const messageId = dto?.messageId?.trim();
  const kind = dto?.kind;
  const threadId = dto?.threadId?.trim();
  if (!senderId || !groupId || !messageId || !kind || !threadId) {
    return undefined;
  }

  const text = typeof dto.text === "string" ? dto.text.trim() : undefined;
  const fileId = typeof dto.fileId === "string" ? dto.fileId.trim() : undefined;
  const token = getSignalrToken().trim() || undefined;
  return {
    messageId,
    senderId,
    groupId,
    threadId,
    kind,
    text,
    fileId,
    token,
  };
}

function onServerMessage(dto: MessageDto) {
  // Prevent echoing to self's previous messages, we filter out sender is self (which equeals to token currently)
  if (dto.senderId === getSignalrToken()) {
    return;
  }
  // Prevent messages from other groups
  if (dto.groupId != process.env.AINEXUS_SIGNALR_GROUP_ID) {
    return;
  }

  const message = normalizeInboundMessage(dto);
  if (!message) {
    return;
  }

  if (!signalrMessageHandler) {
    return;
  }

  console.log(`SignalR inbound message from ${message.senderId}: ${message.text}`);
  void Promise.resolve(signalrMessageHandler(message)).catch((error) => {
    console.error("SignalR inbound handler failed:", error);
  });
}
