import { defineSetupPluginEntry } from "openclaw/plugin-sdk/core";
import { aiNexusPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(aiNexusPlugin);
