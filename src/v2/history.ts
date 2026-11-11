import type { Part } from "@opencode-ai/sdk";
import { EMPTY_MODEL } from "./constants.js";
import type { V2ContextMessage, V2HistoryEntry, V2ToolPartsByCallID } from "../models.js";
import {
  assistantMessage,
  isTypedUserMessage,
  textPart,
  toolResultText,
  userMessage,
} from "./parts.js";

export function convertV2History(
  sessionID: string,
  agent: string,
  messages: readonly V2ContextMessage[],
): V2HistoryEntry[] {
  const history: V2HistoryEntry[] = [];
  const toolParts: V2ToolPartsByCallID = {};

  for (const [index, message] of messages.entries()) {
    const messageID = "id" in message && message.id ? message.id : `${sessionID}:history:${index}`;
    const content = typeof message.content === "string" ? [] : message.content;

    if (isTypedUserMessage(message)) {
      const parts = content.flatMap((item, partIndex) =>
        item.type === "text"
          ? [textPart(sessionID, messageID, "text", partIndex, item.text, 0)]
          : [],
      );
      history.push({ info: userMessage(messageID, sessionID, 0, agent), parts });
    }

    if (message.role === "assistant") {
      const parts = content.flatMap((item, partIndex): Part[] => {
        if (item.type === "text" || item.type === "reasoning") {
          return [textPart(sessionID, messageID, item.type, partIndex, item.text, 0)];
        }
        if (item.type !== "tool-call") return [];
        toolParts[item.id] = {
          id: item.id,
          sessionID,
          messageID,
          type: "tool",
          callID: item.id,
          tool: item.name,
          state: {
            status: "running",
            input: (item.input ?? {}) as Record<string, unknown>,
            time: { start: 0 },
          },
        };
        return [toolParts[item.id]];
      });
      const info = assistantMessage({
        id: messageID,
        sessionID,
        created: 0,
        parentID: "",
        model: EMPTY_MODEL,
      });
      history.push({ info, parts });
    }

    if (message.role === "tool") {
      for (const item of content) {
        if (item.type !== "tool-result") continue;
        const part = toolParts[item.id];
        if (!part) continue;
        part.state = {
          status: "completed",
          input: part.state.input,
          output: toolResultText(item.result),
          title: "",
          metadata: {},
          time: { start: 0, end: 0 },
        };
      }
    }
  }

  return history;
}
