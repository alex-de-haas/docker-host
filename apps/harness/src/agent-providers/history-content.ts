type TranscriptEvent = { type: string; [key: string]: unknown };

const utf8 = new TextEncoder();

/** A standard message reset, contiguous deltas and value-less completion replace a streamed draft. */
function completedFragments(events: TranscriptEvent[]): Map<string, string> {
  const ends = new Map<string, bigint>();
  const ordinal = (value: unknown) => typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value) ? BigInt(value) : undefined;
  for (const event of events) {
    if (event.type !== "provider_fragment" || event.messageBoundary !== "complete" || typeof event.target !== "string") continue;
    const seq = ordinal(event.sourceSequence);
    if (seq !== undefined && seq > (ends.get(event.target) ?? -1n)) ends.set(event.target, seq);
  }
  const complete = new Map<string, string>();
  if (!ends.size) return complete;
  const parts = new Map<string, Map<bigint, TranscriptEvent>>();
  for (const event of events) {
    if (event.type !== "provider_fragment" || typeof event.target !== "string" || !ends.has(event.target)) continue;
    const seq = ordinal(event.sourceSequence);
    if (seq === undefined) continue;
    let entries = parts.get(event.target);
    if (!entries) { entries = new Map(); parts.set(event.target, entries); }
    entries.set(seq, event);
  }
  for (const [target, end] of ends) {
    const entries = parts.get(target), chunks: string[] = [];
    let bytes = 0;
    for (let seq = end - 1n; seq >= 0n; seq--) {
      const part = entries?.get(seq);
      if (!part || typeof part.text !== "string") break;
      if (part.messageBoundary === "start") { complete.set(target, chunks.reverse().join("")); break; }
      bytes += utf8.encode(part.text).byteLength;
      // A native message fits 1 MiB. Bound reconstruction even for third-party providers.
      if (part.messageBoundary || bytes > 1024 * 1024) break;
      chunks.push(part.text);
    }
  }
  return complete;
}

/** An original durable event can arrive after a bounded summary supplied its transcript row. */
export function applyProviderHistoryContent<T extends TranscriptEvent>(events: T[]): T[] {
  const originals = new Map<string, T>();
  for (const event of events) {
    if (event.type === "provider_history_order" && typeof event.target === "string"
      && (typeof event.messageText === "string" || typeof event.toolOutput === "string")) originals.set(event.target, event);
  }
  const recovered = completedFragments(events);
  if (!originals.size && !recovered.size) return events;
  return events.map(event => {
    if (event.type === "assistant_text" && typeof event.providerEventId === "string" && recovered.has(event.providerEventId))
      return { ...event, text: recovered.get(event.providerEventId) };
    const original = typeof event.providerEventId === "string" ? originals.get(event.providerEventId) : undefined;
    if (event.type === "assistant_text" && typeof original?.messageText === "string")
      return { ...event, text: original.messageText };
    if (event.type === "tool_result" && typeof original?.toolOutput === "string")
      return { ...event, output: original.toolOutput, truncated: original.toolOutputTruncated === true || undefined };
    return event;
  });
}
