// oxlint-disable no-unused-vars
import fs from "node:fs/promises";
import path from "node:path";
import { AgentToolResult } from "@mariozechner/pi-agent-core";
import { TextContent } from "@mariozechner/pi-ai";
import { Static, Type } from "@sinclair/typebox";
import type {
  AnyAgentTool,
  OpenClawPluginToolFactory,
  OpenClawPluginService,
} from "openclaw/plugin-sdk/core";
import * as externalApi from "./external-api.js";
import { getMcpConfig, MCPManager } from "./mcp-service.ts";
import { getAiNexusApiKey } from "./runtime.js";

const workflowGroupListSchema = Type.Object({});

const workflowRunSchema = Type.Object({
  shareCode: Type.String({
    description: "Workflow group unique id (shareCode).",
  }),
  parameters: Type.Optional(
    Type.Unsafe<Record<string, string> | null>({
      type: ["object", "null"],
      additionalProperties: {
        type: "string",
      },
      description: "Optional workflow parameters as key-value string pairs, or null.",
    }),
  ),
  inputs: Type.Optional(
    Type.Unsafe<string | null>({
      type: ["string", "null"],
      description: "Workflow input text, or null.",
    }),
  ),
});

const fileDownloadSchema = Type.Object({
  fileId: Type.String({
    description: "File id to download.",
  }),
  destinationDir: Type.String({
    description: "Directory to put the download file.",
  }),
});

const fileUploadSchema = Type.Object({
  filePath: Type.String({
    description: "Absolute local path of file to upload.",
  }),
  description: Type.String({
    description: "File description.",
  }),
  isPublic: Type.Boolean({
    description: "File being public or private.",
  }),
});

type DownloadToolParams = Static<typeof fileDownloadSchema>;
type UploadFileParams = Static<typeof fileUploadSchema>;
type ListWorkflowGroupsParams = Static<typeof workflowGroupListSchema>;
type RunWorkflowGroupParams = Static<typeof workflowRunSchema>;

type WorkflowGroupApiItem = {
  shareCode: string;
  name: string;
  description?: string | null;
  parameters_schema?: string[] | null;
};

type WorkflowGroupSummary = {
  shareCode: string;
  name: string;
  description: string | null;
  parameters_schema: string[] | null;
};

function createErrorResult(errorMessage: string): AgentToolResult<string> {
  const error: TextContent = {
    type: "text",
    text: errorMessage,
  };
  return {
    content: [error],
    details: errorMessage,
  };
}

async function listWorkflowGroups(
  toolCallId: string,
  param: ListWorkflowGroupsParams,
): Promise<AgentToolResult<string>> {
  const AINEXUS_API_KEY = getAiNexusApiKey();
  if (!AINEXUS_API_KEY) {
    return createErrorResult("Cannot find API key in process.env.");
  }

  try {
    const response = await externalApi.getGroups(AINEXUS_API_KEY);

    if (!response.ok) {
      const text = await response.text();
      return createErrorResult(`Failed to fetch workflow groups: (${response.status}) ${text}`);
    }

    const payload = await response.json();
    if (!Array.isArray(payload)) {
      return createErrorResult("Invalid workflow groups response: expected an array.");
    }

    // We only need shareCode, name, description, parameters_schema. We don't need mcpLink, createdAt, updatedAt.
    const groups: WorkflowGroupSummary[] = payload
      .filter((item): item is WorkflowGroupApiItem => {
        return (
          typeof item === "object" &&
          item !== null &&
          typeof (item as WorkflowGroupApiItem).shareCode === "string" &&
          typeof (item as WorkflowGroupApiItem).name === "string"
        );
      })
      .map((item) => {
        const parametersSchema =
          Array.isArray(item.parameters_schema) &&
          item.parameters_schema.every((value) => typeof value === "string")
            ? item.parameters_schema
            : null;
        return {
          shareCode: item.shareCode,
          name: item.name,
          description: typeof item.description === "string" ? item.description : null,
          parameters_schema: parametersSchema,
        };
      });

    const jsonString = JSON.stringify(groups);
    const result: TextContent = {
      type: "text",
      text: jsonString,
    };
    return {
      content: [result],
      details: `Fetched ${groups.length} workflow groups.`,
    };
  } catch (error) {
    return createErrorResult(`Error fetching workflow groups: ${(error as Error).message}`);
  }
}

async function runWorkflowGroup(
  toolCallId: string,
  param: RunWorkflowGroupParams,
): Promise<AgentToolResult<string>> {
  const AINEXUS_API_KEY = getAiNexusApiKey();
  if (!AINEXUS_API_KEY) {
    return createErrorResult("Cannot find API key in process.env.");
  }

  const shareCode = typeof param.shareCode === "string" ? param.shareCode.trim() : "";
  if (!shareCode) {
    return createErrorResult("Parameter shareCode is required and must be a non-empty string.");
  }

  const parameters = param.parameters ?? undefined;
  if (parameters !== null) {
    if (typeof parameters !== "object" || Array.isArray(parameters)) {
      return createErrorResult(
        "Parameter parameters must be an object with string values or null.",
      );
    }
    const invalidEntry = Object.entries(parameters).find(([, value]) => typeof value !== "string");
    if (invalidEntry) {
      return createErrorResult("Parameter parameters must contain only string values.");
    }
  }

  const inputs = param.inputs ?? undefined;
  if (inputs !== null && typeof inputs !== "string") {
    return createErrorResult("Parameter inputs must be a string or null.");
  }

  try {
    const response = await externalApi.runGroup(AINEXUS_API_KEY, shareCode, parameters, inputs);

    if (!response.ok) {
      const text = await response.text();
      return createErrorResult(
        `Failed to execute workflow ${shareCode}: (${response.status}) ${text}`,
      );
    }

    const responseText = await response.text();
    let payload: unknown = responseText;
    try {
      payload = JSON.parse(responseText);
    } catch {
      // Keep plain text payload when API does not return JSON.
    }
    const responseString = typeof payload === "string" ? payload : JSON.stringify(payload);

    const result: TextContent = {
      type: "text",
      text: responseString,
    };
    return {
      content: [result],
      details: `Workflow ${shareCode} executed successfully.`,
    };
  } catch (error) {
    return createErrorResult(`Error executing workflow ${shareCode}: ${(error as Error).message}`);
  }
}

async function downloadFile(
  toolCallId: string,
  param: DownloadToolParams,
): Promise<AgentToolResult<unknown>> {
  const AINEXUS_API_KEY = getAiNexusApiKey();
  if (!AINEXUS_API_KEY) {
    return createErrorResult("Cannot find API key in process.env.");
  }
  const { fileId, destinationDir } = param;
  if (!destinationDir) {
    return createErrorResult("Parameter destinationDir is null or empty.");
  }
  const paraType = typeof destinationDir;
  if (paraType != "string") {
    return createErrorResult(
      `Parameter destinationDir is not string type. Type is: ${paraType}, Value is: ${JSON.stringify(destinationDir)}`,
    );
  }
  const idType = typeof fileId;
  if (idType != "number" && idType != "string") {
    return createErrorResult(
      `Parameter fileId is not string or number type. Type is: ${idType}, Value is: ${JSON.stringify(fileId)}`,
    );
  }

  // Download from server and save to destinationDir
  // curl http://ainexus.phison.com:5155/api/external/v1/Files/{fileId}/download --header 'X-Api-Key: YOUR_SECRET_TOKEN'

  try {
    // 確保目標目錄存在
    await fs.mkdir(destinationDir, { recursive: true });

    // 使用 fetch 下載文件
    const response = await externalApi.downloadFile(AINEXUS_API_KEY, fileId);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    // 讀取文件內容
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // 獲取文件名稱（從響應頭或 URL 中推斷）
    const contentDisposition = response.headers.get("content-disposition");
    let filename = `file_${fileId}`;

    // Content-Disposition can contain both filename= and filename*=
    if (contentDisposition) {
      // Prefer RFC 5987 / 6266 filename*=
      const fnStar = contentDisposition.match(/filename\*\s*=\s*([^;]+)/i);
      if (fnStar) {
        // e.g. UTF-8''237-536x354.jpg  or UTF-8''%E2%82%AC%20rates.jpg
        const value = fnStar[1].trim();
        const parts = value.split("''"); // [charset, encoded]
        const encoded = parts.length === 2 ? parts[1] : value;
        filename = decodeURIComponent(encoded.replace(/^"|"$/g, ""));
      } else {
        // Fallback filename=
        const fn = contentDisposition.match(/filename\s*=\s*([^;]+)/i);
        if (fn) {
          filename = fn[1].trim().replace(/^"|"$/g, "");
        }
      }
    }

    // 構建完整路徑
    const filePath = path.join(destinationDir, filename);

    // 寫入文件
    await fs.writeFile(filePath, buffer);

    const result: TextContent = {
      type: "text",
      text: `File ${fileId} downloaded successfully to ${filePath}`,
    };

    return {
      content: [result],
      details: `File ${fileId} downloaded to ${filePath}`,
    };
  } catch (error) {
    return createErrorResult(`Failed to download file ${fileId}: ${(error as Error).message}`);
  }
}

async function uploadFile(
  toolCallId: string,
  param: UploadFileParams,
): Promise<AgentToolResult<unknown>> {
  const AINEXUS_API_KEY = getAiNexusApiKey();
  if (!AINEXUS_API_KEY) {
    return createErrorResult("Cannot find API key in process.env.");
  }

  if (typeof param.description !== "string") {
    return createErrorResult("description must be a string");
  }

  try {
    // Attach file
    const data = await fs.readFile(param.filePath);
    const file = new File([data], path.basename(param.filePath));
    const form = new FormData();
    form.append("file", file, path.basename(param.filePath));
    // Other fields
    form.append("description", param.description);
    form.append("isPublic", String(param.isPublic));

    const response = await externalApi.uploadFile(AINEXUS_API_KEY, form);

    if (!response.ok) {
      const text = await response.text();
      return createErrorResult(`Failed to upload file: (${response.status}) ${text}`);
    }

    /** Sample response data:
    {
      "success": true,
      "message": "檔案上傳成功",
      "data": {
        "fileId": 1747,
        "fileName": "text file.txt",
        "fileSize": 14,
        "mimeType": "text/plain",
        "fileType": "document",
        "uploadedAt": "2026-03-31T07:22:34.2719825Z",
        "description": null,
        "isPublic": false,
        "error": null,
        "success": true
      }
    }
    */
    const uploadResult = await response.json();
    const jsonString = JSON.stringify(uploadResult);
    const result: TextContent = {
      type: "text",
      text: jsonString,
    };
    // TODO:
    // Only return the public ip and file id on success.
    return {
      content: [result],
      details: `Upload successful: ${jsonString}`,
    };
  } catch (error) {
    return createErrorResult(`Error upload file ${param.filePath}: ${(error as Error).message}`);
  }
}

const aiNexusWorkflowListTool: AnyAgentTool = {
  name: "ai-nexus-workflow-list",
  label: "AI Nexus Workflow List",
  description: "Get available workflow groups from AI Nexus.",
  parameters: workflowGroupListSchema,
  execute: listWorkflowGroups,
};

const aiNexusWorkflowRunTool: AnyAgentTool = {
  name: "ai-nexus-workflow-run",
  label: "AI Nexus Workflow Run",
  description: "Execute a workflow group by shareCode on AI Nexus.",
  parameters: workflowRunSchema,
  execute: runWorkflowGroup,
};

const aiNexusDownloadTool: AnyAgentTool = {
  name: "ai-nexus-file-download",
  label: "AI Nexus File Downloader",
  description: "Download files by id from AI Nexus channel.",
  parameters: fileDownloadSchema,
  execute: downloadFile,
};

const aiNexusUploadTool: AnyAgentTool = {
  name: "ai-nexus-file-upload",
  label: "AI Nexus File Upload",
  description: "Upload file to AI Nexus channel and get file id.",
  parameters: fileUploadSchema,
  execute: uploadFile,
};

export const aiNexusToolsFactory: OpenClawPluginToolFactory = (ctx) => {
  return [
    aiNexusWorkflowListTool,
    aiNexusWorkflowRunTool,
    aiNexusDownloadTool,
    aiNexusUploadTool,
    aiNexusMcpTool,
  ];
};

// Because modelcontextprotocol SDK prints too many lines in the stack trance
function getFirstErrorLine(s: string) {
  const i = s.indexOf("\n");
  return (i === -1 ? s : s.slice(0, i)).trim();
}

let mcpManager: MCPManager | null = null;

export const createMcpService: OpenClawPluginService = {
  id: "ainexus-mcp-service",
  start: async (ctx) => {
    ctx.logger.info("[MCP] Starting...");
    if (!mcpManager) {
      mcpManager = new MCPManager(ctx.logger);
    }
    //const pluginConfig = ctx.config?.plugins?.entries?.["mcp-integration"]?.config || {};
    //const servers = pluginConfig.servers || {};
    const serverResult = await getMcpConfig(ctx.logger);
    if (!serverResult) {
      ctx.logger.error("[MCP] Failed to get config from AI Nexus");
      return;
    }

    for (const [name, config] of Object.entries(serverResult.mcpServers)) {
      // We need to exclude openclaw-bridge, so openclaw won't call itself
      if (name === "openclaw-bridge") {
        continue;
      }
      if (config.url) {
        try {
          await mcpManager.connectServer(name, config);
        } catch (error) {
          const message = error instanceof Error ? getFirstErrorLine(error.message) : String(error);
          ctx.logger.error(`[MCP] Failed to initialize server ${name}: ${message}`);
        }
      }
    }

    ctx.logger.info("[MCP] Started");
  },
  stop: async (ctx) => {
    ctx.logger.info("[MCP] Stopping...");
    await mcpManager?.disconnect();
    mcpManager = null;
  },
};

const mcpSchema = Type.Object({
  action: Type.String({
    items: ["list", "call"],
    description: "Action: list or call",
  }),
  server: Type.String({
    description: "MCP server name (for call)",
  }),
  tool: Type.String({
    description: "Tool name (for call)",
  }),
  args: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: "Tool arguments (for call)",
    }),
  ),
});
type McpParams = Static<typeof mcpSchema>;

const aiNexusMcpTool: AnyAgentTool = {
  name: "ai-nexus-mcp-tool",
  label: "AI Nexus MCP Tool",
  description:
    "Call MCP (Model Context Protocol) server tools. Use action=list to see available tools, then action=call to invoke them.",
  parameters: mcpSchema,
  async execute(toolCallId: string, params: McpParams): Promise<AgentToolResult<unknown>> {
    if (!mcpManager) {
      return createErrorResult("Error: mcpManager is null.");
    }

    try {
      switch (params.action) {
        case "list": {
          const tools = mcpManager.listTools();
          return {
            content: [
              {
                type: "text",
                text:
                  tools.length > 0
                    ? JSON.stringify(tools, null, 2)
                    : "No MCP tools available. Check server connection.",
              },
            ],
            details: "List executed.",
          };
        }

        case "call": {
          if (!params.server || !params.tool) {
            throw new Error("server and tool are required for call action");
          }
          const result = await mcpManager.callTool(params.server, params.tool, params.args || {});
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
            details: "Call executed.",
          };
        }

        default:
          throw new Error(`Unknown action: ${params.action}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return createErrorResult(`Error executing a tool: ${message}`);
    }
  },
};
