/**
 * The router bot decides whether a user message is a plain conversation (CHAT)
 * or a coding task (CODE). It signals this with a leading "CHAT:" / "CODE:"
 * prefix (legacy "NO_CODE_TASK:" is also accepted). This function parses that
 * decision and degrades gracefully when the model ignores the protocol.
 */
export type Route = { kind: "chat" | "code"; content: string };

export function classifyRoute(text: string, userMessage: string): Route {
  const t = (text || "").trim();
  const m = t.match(/^(CHAT|CODE|NO_CODE_TASK)\s*:?\s*/i);
  if (m) {
    const kind = m[1].toUpperCase();
    const content = t.slice(m[0].length).trim();
    if (kind === "CODE") return { kind: "code", content: content || userMessage };
    return { kind: "chat", content };
  }
  // No protocol prefix: an empty reply → treat the raw request as a code task;
  // otherwise assume the bot simply answered conversationally.
  if (!t) return { kind: "code", content: userMessage };
  return { kind: "chat", content: t };
}
