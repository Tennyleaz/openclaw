import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "zod";

const mySchema = z.object({
  token: z.string().optional(),
  webhookPath: z.string(),
  dmPolicy: z.string().optional(),
  execApprovals: z.boolean().optional(),
  aiNexusApiKey: z.string().optional(),  // override AINEXUS_API_KEY environment variable
});

export const AiNexusConfigSchema = buildChannelConfigSchema(mySchema);
