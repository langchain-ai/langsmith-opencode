import type { Plugin } from "@opencode-ai/plugin";
import { OpenCodeSessionTracer } from "./tracer.js";
import { getConfig } from "./config.js";

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
