import { mockClient } from "./mock_client.ts";
import { getAssumedTreeFromCalls } from "./tree.ts";
import { OpenCodeSessionTracer } from "../../src/tracer.js";
import { OpenCodeV2EventTranslator } from "../../src/v2/translator.js";
import type { V2Event, V2SessionContext } from "../../src/models.js";
import { EMPTY_TOKENS } from "../../src/v2/constants.js";
import type { V2RecordedSetup, V2RecordingLine, V2SessionEventInput } from "./models.ts";

export async function traceV2Recording(lines: V2RecordingLine[]) {
  const { client, callSpy } = mockClient();
  let tracer: OpenCodeSessionTracer | undefined;
  let translator: OpenCodeV2EventTranslator | undefined;

  for (const [kind, payload] of lines) {
    if (kind === "setup") {
      const { directory, version } = payload as V2RecordedSetup;
      tracer = new OpenCodeSessionTracer({ enabled: true }, { client, name: "opencode.session" });
      translator = new OpenCodeV2EventTranslator(tracer, version, directory);
    }
    if (kind === "event") await translator?.handleEvent(payload as V2Event);
    if (kind === "session.hook.context")
      await translator?.handleContext(payload as V2SessionContext);
  }
  await tracer?.flush();
  return getAssumedTreeFromCalls(callSpy.mock.calls, client);
}

export function newV2Translator() {
  const { client, callSpy } = mockClient();
  const tracer = new OpenCodeSessionTracer({ enabled: true }, { client, name: "opencode.session" });
  const translator = new OpenCodeV2EventTranslator(tracer, "2.2.7", "/tmp/opencode");
  return { client, callSpy, tracer, translator };
}

export async function traceV2Events(sessionEvents: V2SessionEventInput[]) {
  const { client, callSpy, tracer, translator } = newV2Translator();
  for (const [index, event] of sessionEvents.entries()) {
    await translator.handleEvent({ ...event, created: index + 1 } as V2Event);
  }
  await tracer.flush();
  return getAssumedTreeFromCalls(callSpy.mock.calls, client);
}

const MODEL = { id: "claude-haiku-4-5", providerID: "anthropic" };

export const STOPPED = { finish: "stop", cost: 0, tokens: EMPTY_TOKENS };

export const queueUserMessage = (
  sessionID: string,
  inboxID: string,
  text: string,
  files?: unknown[],
) => ({
  type: "session.inbox.enqueued",
  data: { sessionID, inboxID, item: { type: "user", payload: { text, files } } },
});

export const deliverMessage = (sessionID: string, inboxID: string) => ({
  type: "session.inbox.delivered",
  data: { sessionID, inboxID },
});

export const stepStarted = (sessionID: string, assistantMessageID: string) => ({
  type: "session.step.started",
  data: { sessionID, assistantMessageID, agent: "build", model: MODEL },
});

export const textStep = (sessionID: string, assistantMessageID: string, text: string) => {
  const step = { sessionID, assistantMessageID };
  return [
    stepStarted(sessionID, assistantMessageID),
    { type: "session.text.ended", data: { ...step, ordinal: 0, text } },
    { type: "session.step.ended", data: { ...step, ...STOPPED } },
  ];
};

export const executionEnded = (sessionID: string) => ({
  type: "session.execution.succeeded",
  data: { sessionID },
});
