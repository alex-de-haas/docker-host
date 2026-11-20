type TranscriptEvent = { type: string; [key: string]: unknown };

/** An original durable event can arrive after a bounded summary supplied its transcript row. */
export function applyProviderHistoryContent<T extends TranscriptEvent>(events: T[]): T[] {
  const originals = new Map<string, T>();
  for (const event of events) {
    if (event.type === "provider_history_order" && typeof event.target === "string"
      && (typeof event.messageText === "string" || typeof event.toolOutput === "string")) originals.set(event.target, event);
  }
  if (!originals.size) return events;
  return events.map(event => {
    const original = typeof event.providerEventId === "string" ? originals.get(event.providerEventId) : undefined;
    if (event.type === "assistant_text" && typeof original?.messageText === "string")
      return { ...event, text: original.messageText };
    if (event.type === "tool_result" && typeof original?.toolOutput === "string")
      return { ...event, output: original.toolOutput, truncated: original.toolOutputTruncated === true || undefined };
    return event;
  });
}
