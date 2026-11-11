import type { Plugin as V1Plugin } from "@opencode-ai/plugin";
import type { Message, Model, Part, ToolPart } from "@opencode-ai/sdk";
import type { Plugin } from "@opencode/plugin";
import type { SessionContext } from "@opencode/plugin/promise/session";

export type SystemPromptModel = Pick<Model, "id" | "providerID"> & Partial<Model>;

export type V2Context = Plugin.Context;

export type V2Event = V2Context["event"]["subscribe"] extends (
  ...args: never[]
) => AsyncIterable<infer Event>
  ? Event
  : never;

export type V2EventOf<Type extends V2Event["type"]> = Extract<V2Event, { type: Type }>;

export type V2ToolContent = V2EventOf<"session.tool.success">["data"]["content"][number];

export type V2ContextMessage = SessionContext["messages"][number];

export type V2ToolResult = Extract<
  Exclude<V2ContextMessage["content"], string>[number],
  { type: "tool-result" }
>["result"];

export type { SessionContext as V2SessionContext };

export type V2UserItem = Extract<
  V2EventOf<"session.inbox.enqueued">["data"]["item"],
  { type: "user" }
>;

export type V2HistoryEntry = { info: Message; parts: Part[] };

export type V2FileRef = { uri: string; mime: string; name?: string | undefined };

export type V2AssistantMessageParams = {
  id: string;
  sessionID: string;
  created: number;
  parentID: string;
  model: { id: string; providerID: string };
};

export type V2SessionState = {
  agent: string;
  announced: boolean;
  parentID: string | undefined;
  queuedUserMessages: { [inboxID: string]: { item: V2UserItem; created: number } };
  userMessageID: string | undefined;
  heldStep: V2HeldStep | undefined;
  pendingSystem: { model: SystemPromptModel; system: string[] } | undefined;
  historyLoaded: boolean;
  tools: { [callID: string]: { name: string; input: Record<string, unknown>; start: number } };
};

export type V2SessionsByID = { [sessionID: string]: V2SessionState };

export type V2ToolPartsByCallID = { [callID: string]: ToolPart };

export type V2TextKind = "text" | "reasoning";

export type V2Tokens = V2EventOf<"session.step.ended">["data"]["tokens"];

export type V2HeldStep = { messageID: string; cost: number; tokens: V2Tokens; time: number };

export type DualVersionPlugin = Plugin.Plugin & { server: V1Plugin };
