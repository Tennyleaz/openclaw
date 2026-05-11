import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
//import { aiNexusPlugin } from "./channel.js";
import { setAiNexusRuntime } from "./runtime.js";
import { aiNexusToolsFactory, createMcpService } from "./tool.ts";

export function registerAiNexusHooks(api: OpenClawPluginApi) {
  setAiNexusRuntime(api.runtime);
  //api.registerChannel({ plugin: aiNexusPlugin });
  api.registerTool(aiNexusToolsFactory);
  api.registerService(createMcpService);
}
