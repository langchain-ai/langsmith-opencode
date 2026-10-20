// Structural types for the OpenCode 2 session message model, plus a normalizer
// that maps them onto the tracer's internal message/part IR.
//
// OpenCode 2's public event stream does not carry the V1 `message.updated` /
// `message.part.updated` events the V1 tracer consumes, so the V2 tracer reads
// complete sessions with `session.context` and normalizes them here instead.
// Shapes mirror @opencode/schema 2.1.1 (`SessionMessage.*`, `TokenUsage.Info`).

export type TokenUsage = {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
};

export type V2FileContent = {
  type: "file";
  uri: string;
  mime: string;
  name?: string | null;
};

export type V2TextContent = {
  type: "text";
  text: string;
};

export type V2ToolState =
  | { status: "streaming"; input: string }
  | { status: "running"; input: Record<string, unknown>; metadata?: Record<string, unknown> }
  | {
      status: "completed";
      input: Record<string, unknown>;
      content: unknown[];
      metadata?: Record<string, unknown>;
    }
  | {
      status: "error";
      input: Record<string, unknown>;
      error: { type?: string; message?: string; status?: number };
      content?: unknown[];
      metadata?: Record<string, unknown>;
    };

export type V2AssistantContent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string; time?: { created: number; completed?: number } }
  | {
      type: "tool";
      id: string;
      name: string;
      state: V2ToolState;
      time: { created: number; ran?: number; completed?: number };
    };

export type V2Message =
  | {
      type: "user";
      id: string;
      time: { created: number };
      text: string;
      agent?: string;
      model?: { id?: string; providerID?: string };
    }
  | {
      type: "assistant";
      id: string;
      time: { created: number; streamed?: number; completed?: number };
      agent?: string;
      model?: { id?: string; providerID?: string; name?: string };
      content?: V2AssistantContent[];
      finish?: string;
      tokens?: TokenUsage;
    }
  | { type: "system"; id: string; time: { created: number }; text: string }
  | { type: "idle"; id: string; time: { created: number }; outcome?: string }
  | { type: "compaction"; id: string; time: { created: number }; status?: string }
  | { type: "synthetic"; id: string; time: { created: number }; text?: string };

/** A normalized content part. Mirrors the tracer's `Part` handling for V1 sessions. */
export type TracePart =
  | { kind: "text"; id: string; text: string; metadata?: Record<string, unknown> }
  | { kind: "reasoning"; id: string; text: string }
  | { kind: "file"; id: string; name?: string; url: string; mime: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      callID: string;
      state: {
        status: "pending" | "running" | "completed" | "error";
        input?: unknown;
        output?: unknown;
        error?: unknown;
        metadata?: Record<string, unknown>;
        attachments?: TraceAttachment[];
        time?: { start?: number; end?: number };
      };
    }
  | { kind: "step-finish"; id: string; reason?: string; tokens: TokenUsage };

export type TraceAttachment = { id: string; name?: string; url: string; mime: string };

export type TraceMessage = {
  id: string;
  role: "user" | "assistant";
  created?: number;
  endTime?: number;
  agent?: string;
  modelID?: string;
  providerID?: string;
  modelName?: string;
  /** System prompt in effect when this message was produced. */
  system?: string[];
  parts: TracePart[];
};

const isTextContent = (value: unknown): value is V2TextContent =>
  typeof value === "object" &&
  value != null &&
  (value as { type?: unknown }).type === "text" &&
  typeof (value as { text?: unknown }).text === "string";

const isFileContent = (value: unknown): value is V2FileContent =>
  typeof value === "object" && value != null && (value as { type?: unknown }).type === "file";

const toAttachments = (content: unknown[] | undefined): TraceAttachment[] | undefined => {
  if (!content) return undefined;
  const attachments = content.filter(isFileContent).map((file) => ({
    id: file.name ?? file.uri,
    name: file.name ?? undefined,
    url: file.uri,
    mime: file.mime,
  }));
  return attachments.length > 0 ? attachments : undefined;
};

const toToolOutput = (content: unknown[] | undefined): string | undefined => {
  if (!content) return undefined;
  // File parts are surfaced as `attachments`; the textual payload stays in `output`.
  const text = content
    .filter(isTextContent)
    .map((part) => part.text)
    .join("\n");
  return text.length > 0 ? text : undefined;
};

const normalizeToolState = (state: V2ToolState): Extract<TracePart, { kind: "tool" }>["state"] => {
  if (state.status === "streaming") {
    return { status: "running", input: state.input };
  }

  if (state.status === "running") {
    return { status: "running", input: state.input, metadata: state.metadata };
  }

  if (state.status === "completed") {
    return {
      status: "completed",
      input: state.input,
      output: toToolOutput(state.content),
      metadata: state.metadata,
      attachments: toAttachments(state.content),
    };
  }

  return {
    status: "error",
    input: state.input,
    error: state.error?.message ?? state.error,
    output: toToolOutput(state.content),
    metadata: state.metadata,
  };
};

const normalizeAssistant = (
  message: Extract<V2Message, { type: "assistant" }>,
  system: string[] | undefined,
): TraceMessage => {
  const parts: TracePart[] = [];

  for (const [index, content] of (message.content ?? []).entries()) {
    if (content.type === "text") {
      parts.push({ kind: "text", id: `${message.id}-text-${index}`, text: content.text });
      continue;
    }

    if (content.type === "reasoning") {
      parts.push({ kind: "reasoning", id: `${message.id}-reasoning-${index}`, text: content.text });
      continue;
    }

    parts.push({
      kind: "tool",
      id: content.id,
      name: content.name,
      callID: content.id,
      state: {
        ...normalizeToolState(content.state),
        time: { start: content.time.ran ?? content.time.created, end: content.time.completed },
      },
    });
  }

  // OpenCode 2 reports step usage on the assistant message rather than as a
  // trailing `step-finish` part. Synthesize one so run metadata (model, token
  // usage) is produced from the same shape the V1 tracer uses.
  if (message.tokens) {
    parts.push({
      kind: "step-finish",
      id: `${message.id}-step-finish`,
      reason: message.finish,
      tokens: message.tokens,
    });
  }

  return {
    id: message.id,
    role: "assistant",
    created: message.time.created,
    endTime: message.time.completed ?? message.time.streamed,
    agent: message.agent,
    modelID: message.model?.id,
    providerID: message.model?.providerID,
    modelName: message.model?.name,
    system,
    parts,
  };
};

/**
 * Normalize a `session.context` result into tracer messages.
 *
 * Message kinds other than user/assistant (system, idle, compaction) are not
 * emitted as runs; `idle` instead marks the preceding turn complete.
 */
export const normalizeMessages = (messages: V2Message[]): TraceMessage[] => {
  const normalized: TraceMessage[] = [];

  for (const message of messages) {
    if (message.type === "user") {
      normalized.push({
        id: message.id,
        role: "user",
        created: message.time.created,
        endTime: message.time.created,
        agent: message.agent,
        modelID: message.model?.id,
        providerID: message.model?.providerID,
        parts: [{ kind: "text", id: `${message.id}-text`, text: message.text }],
      });
      continue;
    }

    if (message.type === "assistant") {
      normalized.push(normalizeAssistant(message, undefined));
    }
  }

  return normalized;
};
