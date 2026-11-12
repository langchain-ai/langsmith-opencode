import type { Plugin } from "@opencode-ai/plugin";
import type { DualVersionPlugin } from "./models.js";
import { OpenCodeSessionTracer } from "./tracer.js";
import { getConfig } from "./config.js";
import { V2_PLUGIN_ID } from "./v2/constants.js";
import { startV2Tracing } from "./v2/translator.js";

export const LangSmithPlugin: Plugin = async (ctx) => {
  const config = await getConfig();
  const tracer = new OpenCodeSessionTracer(config);

  // If tracing is disabled, return an empty object
  if (!config.enabled) return {};

  async function getSessionHistory(sessionID: string) {
    const past = await ctx.client.session.messages({
      path: { id: sessionID },
    });
    if (past.error) throw past.error;
    return past.data;
  }

  return {
    "experimental.chat.system.transform": async (input, output) => {
      const sessionID = input.sessionID;
      if (!sessionID) return;

      await tracer.handleSessionLoad(sessionID, getSessionHistory);
      await tracer.handleSystem(input, output);
    },
    event: async (input) => {
      const sessionID =
        "sessionID" in input.event.properties &&
        typeof input.event.properties.sessionID === "string"
          ? input.event.properties.sessionID
          : undefined;

      if (!sessionID) return;

      await tracer.handleSessionLoad(sessionID, getSessionHistory);
      await tracer.handleEvent(input);

      // Flush the tracer when the session is idle
      if (input.event.type === "session.idle") {
        await tracer.flush();
      }
    },
  };
};

export default {
  id: V2_PLUGIN_ID,
  async setup(context) {
    // OpenCode v1 also calls setup, with a partial context that has no event stream.
    if (!("event" in context)) return;
    const config = await getConfig(context.location.directory);
    if (!config.enabled) return;
    return startV2Tracing(context, new OpenCodeSessionTracer(config));
  },
  server: LangSmithPlugin,
} satisfies DualVersionPlugin;
