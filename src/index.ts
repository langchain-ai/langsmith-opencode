import type { Plugin as PluginV1 } from "@opencode-ai/plugin";
// `@opencode/plugin` exposes its types through a namespace export, so the
// definition interface is `Plugin.Plugin`.
import type { Plugin as PluginV2 } from "@opencode/plugin";
import { createV1Plugin } from "./v1.js";
import { setup } from "./v2.js";

/** OpenCode 2 reads `id` and `setup` off the module's default export. */
const definition: PluginV2.Plugin = {
  id: "langsmith",
  setup,
};

/**
 * OpenCode 1 calls `server()` with the plugin context and uses the returned
 * hooks; OpenCode 2 ignores it. Spreading keeps the object assignable to both
 * entrypoint shapes while each version only touches its own key.
 */
export default {
  ...definition,
  server: createV1Plugin,
};

/**
 * Legacy function export, kept for OpenCode 1 releases older than 1.18.29 that
 * discover plugins by scanning named function exports.
 */
export const LangSmithPlugin: PluginV1 = createV1Plugin;
