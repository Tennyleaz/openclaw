import type { PluginRuntime } from "openclaw/plugin-sdk/core";

let runtime: PluginRuntime | null = null;

export function setAiNexusRuntime(r: PluginRuntime): void {
  runtime = r;
}

export function getAiNexusRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("AI Nexus runtime not initialized - plugin not registered");
  }
  return runtime;
}

/** Read aiNexusApiKey from channel config, falling back to env var. */
export function getAiNexusApiKey(): string | undefined {
  if (!runtime) {
    return process.env.AINEXUS_API_KEY;
  }
  const cfg = runtime.config.current();
  const channelCfg = (cfg.channels?.["ai-nexus"] ?? {}) as Record<string, unknown>;
  const configKey =
    typeof channelCfg.aiNexusApiKey === "string" ? channelCfg.aiNexusApiKey : undefined;
  return configKey || process.env.AINEXUS_API_KEY;
}
