import { Client, RunTree, type RunTreeConfig } from "langsmith";
import { createSecretAnonymizer } from "langsmith/anonymizer";
import type { Config } from "../config.js";
import { buildCodingAgentMetadata } from "../shared.js";
import {
  normalizeMessages,
  type TraceMessage,
  type TracePart,
  type V2Message,
} from "./normalize.js";

/** Resolves a sub-session spawned by a tool call into nested runs under that tool. */
export type SubgraphResolver = (input: {
  sessionID: string;
  child: RunTree;
  rootThreadId: string;
}) => Promise<boolean>;

type V2SessionState = {
  parentID: string | undefined;
  runtimeVersion: string | undefined;
  directory: string | undefined;
  /** Turn ids (user message ids) already submitted, so re-reading a session is idempotent. */
  emitted: Set<string>;
  /** System prompt captured for the next assistant run. */
  pendingSystem: string[] | undefined;
};

type Turn = {
  id: string;
  user: TraceMessage;
  agentRuns: TraceMessage[];
  endTime: number;
  complete: boolean;
};

const isAssistantContent = (part: TracePart): part is Extract<TracePart, { kind: "tool" }> =>
  part.kind === "tool";

const toStandardContentBlock = (part: TracePart): unknown => {
  if (part.kind === "step-finish") return [];

  if (part.kind === "text") {
    return { type: "text", text: part.text, extras: part.metadata };
  }

  if (part.kind === "reasoning") {
    return { type: "thinking", thinking: part.text };
  }

  if (part.kind === "file") {
    return { type: "file", id: part.name ?? part.id, url: part.url, mime_type: part.mime };
  }

  return {
    type: "tool_use",
    name: part.name,
    input: part.state.input,
    id: part.callID,
  };
};

const toStandardMessages = (messages: TraceMessage[]): unknown[] =>
  messages.flatMap((message) => {
    if (message.role === "assistant") {
      // split out into "model message"
      return [
        {
          role: "assistant",
          content: message.parts.flatMap(toStandardContentBlock),
        },
        ...message.parts.flatMap((part) => {
          if (!isAssistantContent(part)) return [];
          if (part.state.status === "completed") {
            return {
              role: "tool",
              content: part.state.output,
              name: part.name,
              id: part.id,
              tool_call_id: part.callID,
            };
          }
          if (part.state.status === "error") {
            return {
              role: "tool",
              content: part.state.error,
              name: part.name,
              id: part.id,
              tool_call_id: part.callID,
            };
          }
          return [];
        }),
      ];
    }

    return {
      role: "user",
      content: message.parts.flatMap(toStandardContentBlock),
    };
  });

const getProviderMetadata = (run: TraceMessage): Record<string, unknown> => {
  if (run.role !== "assistant") return {};

  const modelId = run.modelID;
  const providerId = run.providerID;
  const ls_invocation_params: Record<string, unknown> = {
    model: modelId,
    providerID: providerId,
  };
  if (run.modelName) ls_invocation_params.model_display_name = run.modelName;

  const stepFinish = run.parts.find((part) => part.kind === "step-finish");

  return {
    ls_model_name: modelId,
    ls_provider: providerId,
    ls_model_type: "chat",
    ls_invocation_params,

    usage_metadata: stepFinish
      ? {
          input_tokens: stepFinish.tokens.input,
          output_tokens: stepFinish.tokens.output + stepFinish.tokens.reasoning,
          total_tokens:
            stepFinish.tokens.input + stepFinish.tokens.output + stepFinish.tokens.reasoning,
          input_token_details: {
            cache_read: stepFinish.tokens.cache.read,
            cache_creation: stepFinish.tokens.cache.write,
          },
        }
      : undefined,
  };
};

const toErrorString = (error: unknown): string | undefined => {
  if (error == null) return undefined;
  if (typeof error === "string") return error;
  if (typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return JSON.stringify(error);
};

/**
 * Traces OpenCode 2 sessions to LangSmith.
 *
 * OpenCode 2's public event stream carries granular `session.*` events rather
 * than the V1 `message.updated` / `message.part.updated` events, so this tracer
 * reads a whole session with `session.context` and submits each completed turn.
 * Repeated reads are safe: completed turns are only submitted once.
 */
export class OpenCodeSessionTracerV2 {
  private sessions: { [sessionID: string]: V2SessionState } = {};
  private client: Client;
  private inputConfig: Partial<RunTreeConfig>;
  private postRunQueue: Promise<void>[] = [];
  private resolveSubgraph: SubgraphResolver | undefined;

  constructor(
    config: Config,
    inputConfig?: Partial<RunTreeConfig>,
    options?: { resolveSubgraph?: SubgraphResolver },
  ) {
    this.inputConfig = inputConfig ?? {};
    this.inputConfig.project_name ??= config.project;
    this.inputConfig.replicas ??= config.replicas;
    this.inputConfig.tracingEnabled ??= config.enabled;

    this.inputConfig.extra ??= {};
    this.inputConfig.extra.metadata ??= config.metadata;

    this.resolveSubgraph = options?.resolveSubgraph;

    const anonymizer = config.redact
      ? createSecretAnonymizer(
          config.redact_extra_rules ? { extraRules: config.redact_extra_rules } : undefined,
        )
      : undefined;

    this.client =
      inputConfig?.client ??
      new Client({ apiKey: config.api_key, apiUrl: config.api_url, anonymizer });
  }

  private getSession(sessionID: string): V2SessionState {
    this.sessions[sessionID] ??= {
      parentID: undefined,
      runtimeVersion: undefined,
      directory: undefined,
      emitted: new Set<string>(),
      pendingSystem: undefined,
    };
    return this.sessions[sessionID];
  }

  /** Record the system prompt in effect for the session's next assistant run. */
  setSystemPrompt(sessionID: string, system: string[]): void {
    this.getSession(sessionID).pendingSystem = system;
  }

  /**
   * Ingest a session snapshot and submit every completed turn that has not been
   * submitted yet. Returns whether anything was submitted.
   */
  async handleSession(input: {
    sessionID: string;
    rootSessionID?: string;
    parentID?: string;
    runtimeVersion?: string;
    directory?: string;
    messages: V2Message[];
    parentRunTree?: RunTree;
  }): Promise<boolean> {
    const state = this.getSession(input.sessionID);
    state.parentID ??= input.parentID;
    state.runtimeVersion ??= input.runtimeVersion;
    state.directory ??= input.directory;

    const ordered = normalizeMessages(input.messages);
    const byId = new Map(ordered.map((message) => [message.id, message]));

    const turns: Turn[] = [];
    let current: Turn | undefined;

    for (const message of input.messages) {
      if (message.type === "user") {
        const run = byId.get(message.id);
        if (!run) continue;
        if (current) turns.push(current);
        current = {
          id: message.id,
          user: run,
          agentRuns: [],
          endTime: message.time.created,
          complete: false,
        };
        continue;
      }

      if (message.type === "assistant" && current) {
        const run = byId.get(message.id);
        if (!run) continue;
        current.agentRuns.push(run);
        current.endTime = Math.max(current.endTime, run.endTime ?? run.created ?? current.endTime);
        continue;
      }

      if (message.type === "idle" && current) {
        current.complete = true;
        current.endTime = Math.max(current.endTime, message.time.created);
      }
    }

    if (current) turns.push(current);

    const rootThreadId = input.rootSessionID ?? input.parentID ?? input.sessionID;
    let submitted = false;

    for (const turn of turns) {
      // A turn is complete once the session reports idle, once a later user
      // message starts the next turn, or once the model finished the turn
      // without requesting another tool call.
      const isLast = turn === turns.at(-1);
      const finished = turn.agentRuns
        .at(-1)
        ?.parts.some((part) => part.kind === "step-finish" && part.reason === "stop");
      if (!turn.complete && isLast && !finished) continue;
      if (state.emitted.has(turn.id)) continue;

      const index = ordered.findIndex((message) => message.id === turn.id);
      const history = ordered.slice(0, index + 1);
      state.emitted.add(turn.id);
      submitted = true;

      await this.emitTurn({
        sessionID: input.sessionID,
        state,
        turn,
        history,
        rootThreadId,
        ...(input.parentRunTree ? { parentRunTree: input.parentRunTree } : {}),
      });
    }

    return submitted;
  }

  private async emitTurn(input: {
    sessionID: string;
    state: V2SessionState;
    turn: Turn;
    history: TraceMessage[];
    rootThreadId: string;
    parentRunTree?: RunTree;
  }): Promise<void> {
    const { state, turn, history, rootThreadId } = input;
    const isSubagent = input.parentRunTree != null;

    const historyEnd = history.reduce(
      (acc, message) => Math.max(acc, message.endTime ?? message.created ?? 0),
      0,
    );
    const turnId = turn.user.id;
    const turnNumber = history.filter((message) => message.role === "user").length;

    const codingAgentMetadata = buildCodingAgentMetadata({
      agentType: isSubagent ? "subagent" : "root",
      session: state,
      threadId: rootThreadId,
      turnId,
      turnNumber,
    });

    const parentConfig = {
      name: "opencode.session",
      run_type: "chain",
      start_time: turn.user.created ?? Date.now(),
      end_time: Math.max(turn.endTime, historyEnd),
      inputs: { messages: toStandardMessages([turn.user]) },
      outputs: { messages: toStandardMessages(turn.agentRuns) },
      ...this.inputConfig,
      extra: {
        ...this.inputConfig.extra,
        metadata: {
          ...this.inputConfig.extra?.metadata,
          ...codingAgentMetadata,
        },
      },
      client: this.client,
    } as RunTreeConfig;

    const parent = input.parentRunTree?.createChild(parentConfig) ?? new RunTree(parentConfig);
    this.postRunQueue.push(parent.postRun());

    for (const [index, run] of turn.agentRuns.entries()) {
      const startTime = run.created ?? turn.user.created ?? Date.now();
      const endTime = run.parts.reduce(
        (acc, part) => Math.max(acc, part.kind === "tool" ? (part.state.time?.end ?? 0) : 0),
        run.endTime ?? startTime,
      );

      // The system prompt applies to the model request that produced the first
      // assistant run of the turn; it is consumed once, like the V1 tracer.
      const system = index === 0 ? state.pendingSystem : undefined;
      if (index === 0) state.pendingSystem = undefined;

      const child = parent.createChild({
        name: "opencode.assistant.turn",
        run_type: "llm",
        start_time: startTime,
        end_time: endTime,
        inputs: {
          messages: [
            ...(system ? [{ role: "system", content: system.join("\n") }] : []),
            ...toStandardMessages(history),
          ],
        },
        outputs: { messages: toStandardMessages([run]) },
        extra: { metadata: getProviderMetadata(run) },
      });
      this.postRunQueue.push(child.postRun());

      for (const part of run.parts) {
        if (!isAssistantContent(part)) continue;
        const state_ = part.state;

        // A tool call can spawn a sub-session; nest its runs under this tool run.
        const subSessionID = state_.metadata?.sessionId;
        if (this.resolveSubgraph && typeof subSessionID === "string") {
          const handled = await this.resolveSubgraph({
            sessionID: subSessionID,
            child,
            rootThreadId,
          });
          if (handled) continue;
        }

        const tool = child.createChild({
          name: part.name,
          run_type: "tool",
          inputs: (state_.input as Record<string, unknown>) ?? {},
          outputs: {
            output: state_.output,
            attachments:
              state_.attachments?.map((attachment) => ({
                type: "file",
                id: attachment.name ?? attachment.id,
                url: attachment.url,
                mime_type: attachment.mime,
              })) ?? undefined,
          },
          start_time: state_.time?.start ?? startTime,
          end_time: state_.time?.end ?? endTime,
          error: toErrorString(state_.error),
          extra: { metadata: state_.metadata },
        });

        this.postRunQueue.push(tool.postRun());
      }
    }

    // ls_subagent_* is subagent-only; stamp the root after createChild copied
    // children, since null would leak onto llm/tool children.
    if (isSubagent && parent.extra) {
      const subagentType = turn.user.agent;
      parent.extra.metadata = {
        ...parent.extra.metadata,
        ls_subagent_id: input.sessionID,
        ...(subagentType ? { ls_subagent_type: subagentType } : {}),
      };
    }
  }

  async flush(): Promise<void> {
    await Promise.all(this.postRunQueue);
    this.postRunQueue = [];
    await this.client.flush();
    await this.client.awaitPendingTraceBatches();
  }
}
