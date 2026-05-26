// oxlint-disable typescript/no-explicit-any
// oxlint-disable no-unused-vars
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { PluginLogger } from "openclaw/plugin-sdk/core";
import * as externalApi from "./external-api.js";
import { getAiNexusApiKey } from "./runtime.js";

// This is copied from:
// https://github.com/lunarpulse/openclaw-mcp-plugin

interface McpClientData {
  client: Client;
  transport: Transport;
}

interface McpToolData {
  client: Client;
  server: string;
  tool: any;
}

/**
 * MCP Integration Plugin for OpenClaw
 * Connects to MCP servers via Streamable HTTP transport
 */
export class MCPManager {
  logger: PluginLogger;
  clients: Map<string, McpClientData>;
  tools: Map<string, McpToolData>;

  constructor(logger: PluginLogger) {
    this.logger = logger;
    this.clients = new Map();
    this.tools = new Map();
  }

  async connectServer(name: string, config: McpServerConfig): Promise<void> {
    try {
      const url = config.url;
      let safeUrl = url;
      try {
        const u = new URL(url);
        u.password = "";
        u.username = "";
        safeUrl = u.toString();
      } catch {
        // invalid url, just keep it as is or mask it
        this.logger.error(`[MCP] Invalid url: ${url}`);
        return;
      }
      this.logger.info(`[MCP] Connecting to ${name} at ${safeUrl}`);

      let transport: Transport;
      if (config.type == "sse") {
        transport = new SSEClientTransport(new URL(url));
      } else if (config.type == "streamable-http") {
        transport = new StreamableHTTPClientTransport(new URL(url));
      } else {
        this.logger.error(`[MCP] Unsupoorted transport: ${config.type}`);
        return;
      }

      const client = new Client(
        { name: `ainexus-${name}`, version: "0.0.1" },
        { capabilities: {} },
      );

      await client.connect(transport);

      const { tools } = await client.listTools();

      this.clients.set(name, { client, transport });

      tools.forEach((tool) => {
        this.tools.set(`${name}:${tool.name}`, {
          server: name,
          tool,
          client,
        });
      });

      this.logger.info(`[MCP] Connected to ${name}: ${tools.length} tools available`);
      //return tools;
      return;
    } catch (error) {
      this.logger.error(`[MCP] connectServer(${name}) fail.`);
      throw error;
    }
  }

  async callTool(serverName: string, toolName: string, args = {}) {
    const toolKey = `${serverName}:${toolName}`;
    const entry = this.tools.get(toolKey);

    if (!entry) {
      throw new Error(
        `Tool not found: ${toolKey}. Available: ${Array.from(this.tools.keys()).join(", ")}`,
      );
    }

    const result = await entry.client.callTool({ name: toolName, arguments: args });
    return result;
  }

  listTools() {
    const toolList = [];
    for (const [key, entry] of this.tools.entries()) {
      toolList.push({
        id: key,
        server: entry.server,
        name: entry.tool.name,
        description: entry.tool.description,
        inputSchema: entry.tool.inputSchema,
      });
    }
    return toolList;
  }

  async disconnect() {
    for (const [name, { client }] of this.clients.entries()) {
      try {
        await client.close();
        this.logger.info(`[MCP] Disconnected from ${name}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`[MCP] Error disconnecting from ${name}: ${message}`);
      }
    }
    this.clients.clear();
    this.tools.clear();
  }
}

interface McpConfigResponse {
  mcpServers: Record<string, McpServerConfig>;
}

interface McpServerConfig {
  type: string;
  url: string;
  headers?: Record<string, string>;
  alwaysAllow: string[];
  disabled: boolean;
}

export async function getMcpConfig(logger: PluginLogger): Promise<McpConfigResponse | null> {
  const AINEXUS_API_KEY = getAiNexusApiKey();
  if (!AINEXUS_API_KEY) {
    logger.error("[MCP] Cannot get api key in AINEXUS_API_KEY, skipping.");
    return null;
  }

  try {
    const response = await externalApi.getMcpConfig(AINEXUS_API_KEY);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const json = await response.json();
    return json as McpConfigResponse;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("[MCP] Get mcp config error: " + message);
    return null;
  }

  /**
  Example output:
  {
    "mcpServers": {
        "database": {
            "type": "streamable-http",
            "url": "http://192.168.41.133:5155/api/v1/Agent/mcp/1/MzoxNzc1MDk1OTc5.p0RoSVDRGM_J1toaXFfh0ajNJh3Udl2kE66uQv8mRac",
            "headers": {
                "DSN": "postgres://postgres:1217@192.168.41.208:5111/ChatDB?sslmode=disable"
            },
            "alwaysAllow": [],
            "disabled": false
        },
        "filesystem": {
            "type": "sse",
            "url": "http://192.168.41.133:5155/api/v1/Agent/mcp/2/MzoxNzc1MDk1OTc5.p0RoSVDRGM_J1toaXFfh0ajNJh3Udl2kE66uQv8mRac",
            "headers": {
                "USERNAME": "john",
                "PASSWORD": "hunter2",
                "DIRECTORY": "\\\\192.168.41.208\\share"
            },
            "alwaysAllow": [],
            "disabled": false
        }
    }
   */
}
