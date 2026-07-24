import { ChatMessage } from "../providers/types";

/**
 * Cap how much conversation history is sent to the model so long, multi-turn
 * sessions do not overflow a small local-model context. Trims from the front
 * only at a user-message boundary, so assistant/tool (tool_use/tool_result)
 * pairs stay intact and the first sent message is always a user turn — which the
 * chat APIs require.
 */
export function trimHistory(history: ChatMessage[], maxMessages = 40): ChatMessage[] {
  if (history.length <= maxMessages) return history;
  let start = history.length - maxMessages;
  while (start < history.length && history[start].role !== "user") {
    start++;
  }
  if (start >= history.length) {
    const lastUser = history.map((m) => m.role).lastIndexOf("user");
    start = lastUser >= 0 ? lastUser : 0;
  }
  return history.slice(start);
}
