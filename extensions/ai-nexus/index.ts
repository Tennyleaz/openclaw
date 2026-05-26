import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { aiNexusPlugin } from "./src/channel.js";
import { registerAiNexusHooks } from "./src/hooks.js";

export default defineChannelPluginEntry({
  id: "ai-nexus",
  name: "AI Nexus",
  description: "AI Nexus channel plugin for OpenClaw",
  plugin: aiNexusPlugin,
  registerFull: registerAiNexusHooks,
});
