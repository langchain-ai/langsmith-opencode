import type { Event, Part, ToolPart } from "@opencode-ai/sdk";
import { OpenCodeSessionTracer } from "../tracer.js";
import { convertV2History } from "./history.js";
import {
  AUTO_COMPACTION,
  CONTINUED_REASON,
  EMPTY_MODEL,
  EMPTY_TOKENS,
  LOG_PREFIX,
  STOP_REASON,
} from "./constants.js";
import type {
  V2Context,
  V2Event,
  V2EventOf,
  V2HeldStep,
  V2SessionContext,
  V2SessionsByID,
} from "../models.js";
import * as v1 from "./parts.js";

export class OpenCodeV2EventTranslator {
  private sessions: V2SessionsByID = {};

  constructor(
    private tracer: OpenCodeSessionTracer,
    private runtimeVersion: string,
    private directory: string,
  ) {}

  private getSession(sessionID: string) {
    this.sessions[sessionID] ??= {
      agent: "",
      announced: false,
      parentID: undefined,
      queuedUserMessages: {},
      userMessageID: undefined,
      heldStep: undefined,
      pendingSystem: undefined,
      historyLoaded: false,
      tools: {},
    };
    return this.sessions[sessionID];
  }

  private async emit(sessionID: string, event: Event) {
    await this.tracer.handleEvent({
      event: { ...event, properties: { ...event.properties, sessionID } } as Event,
    });
  }

  private async emitPart(part: Part, time: number) {
    await this.tracer.handleEvent({
      event: {
        type: "message.part.updated",
        properties: { part, sessionID: part.sessionID, time },
      } as Event,
    });
  }

  private async announceSession(sessionID: string, parentID: string | undefined) {
    const session = this.getSession(sessionID);
    session.announced = true;
    session.parentID = parentID;
    await this.emit(sessionID, {
      type: "session.created",
      properties: {
        info: {
          id: sessionID,
          projectID: "",
          directory: this.directory,
          parentID,
          title: "",
          version: this.runtimeVersion,
          time: { created: 0, updated: 0 },
        },
      },
    });
  }

  public async handleContext(context: V2SessionContext) {
    const session = this.getSession(context.sessionID);
    session.pendingSystem = {
      model: { id: context.model.id, providerID: context.model.providerID },
      system: context.system.map((part) => part.text),
    };

    if (session.historyLoaded) return;
    session.historyLoaded = true;
    const currentTurn = context.messages.findLastIndex((message) => message.role === "user");
    const earlier = context.messages.slice(0, Math.max(currentTurn, 0));
    const history = convertV2History(context.sessionID, session.agent, earlier);
    await this.tracer.handleSessionLoad(context.sessionID, async () => history);
  }

  public async handleEvent(event: V2Event) {
    switch (event.type) {
      case "session.created":
        return this.onSessionCreated(event);
      case "session.inbox.enqueued":
        return this.onUserQueued(event);
      case "session.inbox.delivered":
        return this.onUserDelivered(event);
      case "session.step.started":
        return this.onStepStarted(event);
      case "session.text.ended":
      case "session.reasoning.ended":
        return this.onText(event);
      case "session.tool.input.started":
        return this.onToolNamed(event);
      case "session.tool.called":
        return this.onToolCalled(event);
      case "session.tool.success":
      case "session.tool.failed":
        return this.onToolEnded(event);
      case "session.step.ended":
        return this.onStepEnded(event);
      case "session.step.failed":
        return this.onStepFailed(event);
      case "session.compaction.started":
        return this.onCompactionStarted(event);
      case "session.compaction.ended":
      case "session.compaction.failed":
        return this.onCompactionEnded(event);
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
        return this.onExecutionEnded(event.data.sessionID);
    }
  }

  private async onSessionCreated(event: V2EventOf<"session.created">) {
    const session = this.getSession(event.data.sessionID);
    if (event.data.agent) session.agent = event.data.agent;
    await this.announceSession(event.data.sessionID, event.data.parentID);
  }

  private onUserQueued(event: V2EventOf<"session.inbox.enqueued">) {
    const { sessionID, inboxID, item } = event.data;
    if (item.type !== "user") return;
    const session = this.getSession(sessionID);
    session.queuedUserMessages[inboxID] = { item, created: event.created };
  }

  private async onUserDelivered(event: V2EventOf<"session.inbox.delivered">) {
    const { sessionID, inboxID } = event.data;
    const session = this.getSession(sessionID);
    const queued = session.queuedUserMessages[inboxID];
    if (!queued) return;
    delete session.queuedUserMessages[inboxID];
    const { item, created } = queued;
    if (!session.announced) await this.announceSession(sessionID, undefined);
    await this.finishHeldStep(sessionID, STOP_REASON);
    session.userMessageID = inboxID;

    await this.emit(sessionID, {
      type: "message.updated",
      properties: { info: v1.userMessage(inboxID, sessionID, created, session.agent) },
    });
    await this.emitPart(
      v1.textPart(sessionID, inboxID, "text", 0, item.payload.text, created),
      created,
    );
    for (const [index, file] of (item.payload.files ?? []).entries()) {
      const uri =
        file.source.type === "uri" ? file.source.uri : `data:${file.mime};base64,${file.data}`;
      const id = v1.partID(inboxID, "file", index);
      await this.emitPart(
        v1.toFilePart(sessionID, inboxID, id, { uri, mime: file.mime, name: file.name }),
        created,
      );
    }
  }

  private async onExecutionEnded(sessionID: string) {
    await this.finishHeldStep(sessionID, STOP_REASON);
    if (this.getSession(sessionID).parentID === undefined) await this.tracer.flush();
  }

  private async holdStep(sessionID: string, step: V2HeldStep) {
    await this.finishHeldStep(sessionID, CONTINUED_REASON);
    this.getSession(sessionID).heldStep = step;
  }

  public async finishHeldSteps() {
    for (const sessionID of Object.keys(this.sessions)) {
      await this.finishHeldStep(sessionID, STOP_REASON);
    }
  }

  private async finishHeldStep(sessionID: string, reason: string) {
    const session = this.getSession(sessionID);
    const held = session.heldStep;
    if (!held) return;
    session.heldStep = undefined;
    const part = v1.stepFinishPart(sessionID, held.messageID, reason, held.cost, held.tokens);
    await this.emitPart(part, held.time);
  }

  private async onStepStarted(event: V2EventOf<"session.step.started">) {
    const { sessionID, assistantMessageID, model, started } = event.data;
    const session = this.getSession(sessionID);
    await this.finishHeldStep(sessionID, CONTINUED_REASON);
    await this.applyPendingSystem(sessionID);

    const info = v1.assistantMessage({
      id: assistantMessageID,
      sessionID,
      created: started,
      parentID: session.userMessageID ?? "",
      model,
    });
    await this.emit(sessionID, { type: "message.updated", properties: { info } });
  }

  private async onText(event: V2EventOf<"session.text.ended" | "session.reasoning.ended">) {
    const { sessionID, assistantMessageID, ordinal, text } = event.data;
    const type = event.type === "session.text.ended" ? "text" : "reasoning";
    await this.emitPart(
      v1.textPart(sessionID, assistantMessageID, type, ordinal, text, event.created),
      event.created,
    );
  }

  private onToolNamed(event: V2EventOf<"session.tool.input.started">) {
    const session = this.getSession(event.data.sessionID);
    session.tools[event.data.id] = { name: event.data.name, input: {}, start: event.created };
  }

  private async onToolCalled(event: V2EventOf<"session.tool.called">) {
    const { sessionID, assistantMessageID, id, input } = event.data;
    const session = this.getSession(sessionID);
    const name = session.tools[id]?.name ?? "";
    session.tools[id] = { name, input: { ...input }, start: event.created };

    await this.emitPart(
      this.toolPart(sessionID, assistantMessageID, id, {
        status: "running",
        input: session.tools[id].input,
        time: { start: event.created },
      }),
      event.created,
    );
  }

  private async onToolEnded(event: V2EventOf<"session.tool.success" | "session.tool.failed">) {
    const { sessionID, assistantMessageID, id, metadata } = event.data;
    const tool = this.getSession(sessionID).tools[id];
    const ended = {
      input: tool?.input ?? {},
      metadata: v1.toolMetadata(metadata),
      time: { start: tool?.start ?? event.created, end: event.created },
    };
    const content = event.data.content ?? [];
    const attachments = v1.toolAttachments(sessionID, assistantMessageID, id, content);
    let state: ToolPart["state"];
    if (event.type === "session.tool.failed") {
      state = { ...ended, status: "error", error: event.data.error.message };
    } else {
      state = { ...ended, status: "completed", output: v1.toolOutputText(content), title: "" };
      if (attachments.length > 0) state.attachments = attachments;
    }

    await this.emitPart(this.toolPart(sessionID, assistantMessageID, id, state), event.created);
  }

  private toolPart(
    sessionID: string,
    messageID: string,
    callID: string,
    state: ToolPart["state"],
  ): ToolPart {
    const tool = this.getSession(sessionID).tools[callID]?.name ?? "";
    return { id: callID, sessionID, messageID, type: "tool", callID, tool, state };
  }

  private async onStepEnded(event: V2EventOf<"session.step.ended">) {
    const { sessionID, assistantMessageID, finish, cost, tokens } = event.data;
    if (finish === STOP_REASON) {
      return this.holdStep(sessionID, {
        messageID: assistantMessageID,
        cost,
        tokens,
        time: event.created,
      });
    }
    const part = v1.stepFinishPart(sessionID, assistantMessageID, finish, cost, tokens);
    await this.emitPart(part, event.created);
  }

  private async onStepFailed(event: V2EventOf<"session.step.failed">) {
    const { sessionID, assistantMessageID } = event.data;
    await this.holdStep(sessionID, {
      messageID: assistantMessageID,
      cost: 0,
      tokens: EMPTY_TOKENS,
      time: event.created,
    });
  }

  private async applyPendingSystem(sessionID: string) {
    const pending = this.getSession(sessionID).pendingSystem;
    if (!pending) return;
    await this.tracer.handleSystem({ model: pending.model, sessionID }, { system: pending.system });
  }

  private async onCompactionStarted(event: V2EventOf<"session.compaction.started">) {
    const { sessionID, inputID, reason } = event.data;
    const session = this.getSession(sessionID);
    const id = inputID ?? session.userMessageID ?? `${sessionID}:compaction:${event.created}`;
    if (id !== session.userMessageID) {
      if (!session.announced) await this.announceSession(sessionID, undefined);
      session.userMessageID = id;
      const info = v1.userMessage(id, sessionID, event.created, session.agent);
      await this.emit(sessionID, { type: "message.updated", properties: { info } });
    }
    await this.emitPart(
      v1.compactionPart(sessionID, id, event.created, reason === AUTO_COMPACTION),
      event.created,
    );
  }

  private async onCompactionEnded(
    event: V2EventOf<"session.compaction.ended" | "session.compaction.failed">,
  ) {
    const { sessionID, cost, tokens } = event.data;
    await this.applyPendingSystem(sessionID);
    const parentID = this.getSession(sessionID).userMessageID ?? "";
    const id = `${parentID}:summary:${event.created}`;
    const info = v1.assistantMessage({
      id,
      sessionID,
      created: event.created,
      parentID,
      model: EMPTY_MODEL,
    });
    await this.emit(sessionID, { type: "message.updated", properties: { info } });
    if (event.type === "session.compaction.ended") {
      const summary = v1.textPart(sessionID, id, "text", 0, event.data.text, event.created);
      await this.emitPart(summary, event.created);
    }
    await this.holdStep(sessionID, {
      messageID: id,
      cost: cost ?? 0,
      tokens: tokens ?? EMPTY_TOKENS,
      time: event.created,
    });
  }
}

export async function startV2Tracing(context: V2Context, tracer: OpenCodeSessionTracer) {
  const translator = new OpenCodeV2EventTranslator(
    tracer,
    context.app.version,
    context.location.directory,
  );
  const readRequest = (request: V2SessionContext) =>
    translator.handleContext(request).catch((error: unknown) => {
      console.warn(`${LOG_PREFIX} could not read the model request:`, error);
    });
  const hooks = await Promise.all([
    context.session.hook("context", readRequest),
    context.session.hook("compaction", readRequest),
  ]);

  const controller = new AbortController();
  void (async () => {
    for await (const event of context.event.subscribe({ signal: controller.signal })) {
      await translator.handleEvent(event).catch((error: unknown) => {
        console.warn(`${LOG_PREFIX} could not trace ${event.type}:`, error);
      });
    }
    if (!controller.signal.aborted)
      console.warn(`${LOG_PREFIX} event stream ended, tracing stopped`);
  })().catch((error: unknown) => {
    if (!controller.signal.aborted) console.warn(`${LOG_PREFIX} stopped tracing:`, error);
  });

  return async () => {
    controller.abort();
    await Promise.all(hooks.map((hook) => hook.dispose()));
    await translator.finishHeldSteps();
    await tracer.flush();
  };
}
