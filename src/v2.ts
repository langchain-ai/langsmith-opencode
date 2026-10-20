import type { Plugin } from "@opencode/plugin";
import type { RunTree } from "langsmith";
import { getConfig } from "./config.js";
import type { V2Message } from "./v2/normalize.js";
import { OpenCodeSessionTracerV2, type SubgraphResolver } from "./v2/tracer.js";

type PluginDefinition = Plugin.Plugin;
type Context = Parameters<PluginDefinition["setup"]>[0];

/**
 * OpenCode 2 plugin entrypoint.
 *
 * OpenCode 2's public event stream does not carry the V1 `message.updated` /
 * `message.part.updated` events, so turns are submitted from a session snapshot
 * taken when the session goes idle. Sub-sessions are submitted from the parent's
 * tool call when the tool reports the session it spawned, and flushed on their
 * own at shutdown otherwise.
 */
export const setup: PluginDefinition["setup"] = async (ctx: Context) => {
  const config = await getConfig();

  // Tracing is disabled by default; register nothing at all.
  if (!config.enabled) return;

  const parents = new Map<string, string | undefined>();
  const deferred = new Set<string>();

  /** Walk parent links until a session with no parent is found. */
  const rootOf = (sessionID: string): string => {
    const seen = new Set<string>();
    let current = sessionID;

    for (;;) {
      if (seen.has(current)) return sessionID;
      seen.add(current);

      const parent = parents.get(current);
      if (!parent) return current;
      current = parent;
    }
  };

  let tracer: OpenCodeSessionTracerV2;

  const snapshot = async (
    sessionID: string,
    options: { rootSessionID: string; parentRunTree?: RunTree },
  ): Promise<boolean> => {
    const [info, messages] = await Promise.all([
      ctx.session.get({ sessionID }),
      ctx.session.context({ sessionID }),
    ]);

    // `session.context` returns the V2 message union; the tracer consumes the
    // subset it models and ignores the rest.
    return tracer.handleSession({
      sessionID,
      rootSessionID: options.rootSessionID,
      parentID: info.parentID,
      runtimeVersion: ctx.app.version,
      directory: info.location?.directory,
      messages: messages as unknown as V2Message[],
      ...(options.parentRunTree ? { parentRunTree: options.parentRunTree } : {}),
    });
  };

  const resolveSubgraph: SubgraphResolver = async ({ sessionID, child, rootThreadId }) => {
    // Only the `ses_`-prefixed ids OpenCode hands to tools can name a session.
    if (!sessionID.startsWith("ses")) return false;

    const info = await ctx.session.get({ sessionID }).catch(() => undefined);
    if (!info?.parentID) return false;

    parents.set(sessionID, info.parentID);
    const submitted = await snapshot(sessionID, {
      rootSessionID: rootThreadId,
      parentRunTree: child,
    });

    // If the sub-session had not finished yet, keep it queued so the shutdown
    // flush still submits it rather than dropping the trace.
    if (submitted) deferred.delete(sessionID);
    else deferred.add(sessionID);

    return true;
  };

  tracer = new OpenCodeSessionTracerV2(config, undefined, { resolveSubgraph });

  // The system prompt is not part of `session.context`, so capture it from the
  // model request that follows it and attach it to the next assistant run.
  await ctx.session.hook("context", (event) => {
    const system = event.system.flatMap((part) => {
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? [text] : [];
    });

    if (system.length > 0) tracer.setSystemPrompt(event.sessionID, system);
  });

  const flush = async (): Promise<void> => {
    for (const sessionID of [...deferred]) {
      deferred.delete(sessionID);
      await snapshot(sessionID, { rootSessionID: rootOf(sessionID) }).catch(() => undefined);
    }

    await tracer.flush();
  };

  const onSessionSettled = async (sessionID: string): Promise<void> => {
    const info = await ctx.session.get({ sessionID }).catch(() => undefined);
    if (!info || info.parentID) {
      // Sub-sessions are submitted by the parent's tool call so they nest under
      // it; keep them as a fallback in case no tool ever claims them.
      if (info) deferred.add(sessionID);
      return;
    }

    parents.set(sessionID, undefined);
    await snapshot(sessionID, { rootSessionID: rootOf(sessionID) });

    // Flush on idle, as the V1 plugin does. A short-lived process (`opencode
    // run`) exits before the SDK's batch timer fires, which would otherwise
    // drop the runs that were just submitted.
    await tracer.flush();
  };

  const controller = new AbortController();

  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (event.type === "session.created") {
          parents.set(event.data.sessionID, event.data.parentID);
          continue;
        }

        // OpenCode 2 signals a finished turn with the execution events. The
        // deprecated `session.idle` and `session.status` are kept as extra
        // signals because they are still emitted in other flows.
        if (
          event.type === "session.execution.succeeded" ||
          event.type === "session.execution.failed" ||
          event.type === "session.execution.interrupted"
        ) {
          await onSessionSettled(event.data.sessionID);
          continue;
        }

        if (event.type === "session.idle") {
          await onSessionSettled(event.data.sessionID);
          continue;
        }

        if (event.type === "session.status" && event.data.status.type === "idle") {
          await onSessionSettled(event.data.sessionID);
          continue;
        }

        if (event.type === "location.shutdown") await flush();
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        // Losing the event stream should not take the session down with it.
        console.error("[langsmith-opencode] event stream stopped", error);
      }
    }
  })();

  return async () => {
    controller.abort();
    await flush().catch(() => undefined);
  };
};
