import type { AssistantMessage, FilePart, Part, UserMessage } from "@opencode-ai/sdk";
import { EMPTY_TOKENS } from "./constants.js";
import type {
  V2AssistantMessageParams,
  V2FileRef,
  V2TextKind,
  V2ToolContent,
  V2ToolResult,
} from "../models.js";

export const partID = (messageID: string, kind: string, index = 0) =>
  `${messageID}:${kind}:${index}`;

export const textPart = (
  sessionID: string,
  messageID: string,
  type: V2TextKind,
  index: number,
  text: string,
  time: number,
): Part => ({
  id: partID(messageID, type, index),
  sessionID,
  messageID,
  type,
  text,
  time: { start: time, end: time },
});

export const userMessage = (
  id: string,
  sessionID: string,
  created: number,
  agent: string,
): UserMessage => ({
  id,
  sessionID,
  role: "user",
  time: { created },
  agent,
  model: { providerID: "", modelID: "" },
});

export const assistantMessage = (params: V2AssistantMessageParams): AssistantMessage => ({
  id: params.id,
  sessionID: params.sessionID,
  role: "assistant",
  time: { created: params.created },
  parentID: params.parentID,
  modelID: params.model.id,
  providerID: params.model.providerID,
  mode: "",
  path: { cwd: "", root: "" },
  cost: 0,
  tokens: EMPTY_TOKENS,
});

export const toFilePart = (
  sessionID: string,
  messageID: string,
  id: string,
  file: V2FileRef,
): FilePart => ({
  id,
  sessionID,
  messageID,
  type: "file",
  mime: file.mime,
  filename: file.name,
  url: file.uri,
});

export const toolOutputText = (content: readonly V2ToolContent[]) =>
  content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n");

export const toolResultText = (result: V2ToolResult) => {
  if (result.type === "content") return toolOutputText(result.value);
  if (typeof result.value === "string") return result.value;
  return JSON.stringify(result.value);
};

export const toolAttachments = (
  sessionID: string,
  messageID: string,
  callID: string,
  content: readonly V2ToolContent[],
) =>
  content.flatMap((item, index) =>
    item.type === "file"
      ? [toFilePart(sessionID, messageID, partID(callID, "attachment", index), item)]
      : [],
  );

// v1 links a subagent tool call to its child session through `sessionId`.
export const toolMetadata = (metadata: Record<string, unknown> | undefined) =>
  typeof metadata?.sessionID === "string"
    ? { ...metadata, sessionId: metadata.sessionID }
    : (metadata ?? {});
