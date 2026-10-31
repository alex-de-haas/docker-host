import { shouldRetainToolOutput } from "../harness/tool-result.js";
import { createHash } from "node:crypto";
import type { HistoryData, HistoryEntry, HistoryPart, ProviderRef } from "@hosty-sdk/app/history";
import type { SessionRecord, StoredEvent } from "../sessions/store.js";

export const fingerprint = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const fold = (value: string): string => value.normalize("NFKC").toLowerCase().replaceAll("ß", "ss").replaceAll("ς", "σ");
export function searchable(entry: HistoryEntry): string {
  return entry.data.kind === "extension" ? entry.data.fallbackText ?? ""
    : "parts" in entry.data ? entry.data.parts.filter(p => p.type === "text").map(p => p.text).join("\n") : "";
}
export type ProjectedEntry = Omit<HistoryEntry, "revision" | "sequence">;
/** Project only public transcript fields. Native provider state and account diagnostics stay private. */
export function project(record: SessionRecord, events: StoredEvent[], provider: ProviderRef): ProjectedEntry[] {
  const entries: ProjectedEntry[] = [];
  const add = (event: StoredEvent, data: HistoryData, actor: HistoryEntry["actor"]) => entries.push({
    ref: { conversation: { provider, id: record.id }, id: `event-${event.seq}` }, createdAt: event.ts,
    updatedAt: event.ts, actor, data,
  });
  let assistant: ProjectedEntry | undefined;
  const finish = (state: "complete" | "interrupted") => {
    if (assistant?.data.kind === "message") assistant.data.state = state;
    assistant = undefined;
  };
  for (const event of events) {
    if (event.type === "user_message" && typeof event.text === "string") {
      finish("interrupted");
      const parts: HistoryPart[] = [{ type: "text", text: event.text, format: "plain" }];
      for (const name of Array.isArray(event.attachments) ? event.attachments : []) {
        if (typeof name !== "string" || !name || /[\\/\u0000-\u001f]/.test(name) || name.startsWith(".")) continue;
        const added = events.find(e => e.type === "attachment_added" && e.name === name && e.seq <= event.seq);
        parts.push({ type: "attachment", attachmentId: name, name, revision: String(added?.seq ?? event.seq), mediaType: "application/octet-stream",
          ...(typeof added?.size === "number" && added.size >= 0 ? { sizeBytes: added.size } : {}) });
      }
      add(event, { kind: "message", role: "user", parts, state: "complete" }, { kind: "user", id: record.createdBy });
    } else if (event.type === "assistant_text" && typeof event.text === "string") {
      if (!assistant) {
        add(event, { kind: "message", role: "assistant", parts: [{ type: "text", text: event.text, format: "markdown" }], state: "streaming" }, { kind: "agent" });
        assistant = entries.at(-1)!;
      } else if (assistant.data.kind === "message" && assistant.data.parts[0]?.type === "text") {
        assistant.data.parts[0].text += event.text; assistant.updatedAt = event.ts;
      }
    } else if (event.type === "tool_use" && typeof event.toolName === "string" && shouldRetainToolOutput(event.toolName)) {
      finish("complete");
      add(event, { kind: "tool_call", callId: typeof event.toolUseId === "string" ? event.toolUseId : `legacy-${event.seq}`,
        toolName: event.toolName, input: null, disclosure: "redacted" }, { kind: "agent" });
    } else if (event.type === "tool_result" && typeof event.toolUseId === "string" && typeof event.output === "string") {
      finish("complete");
      const outcome = ["completed", "failed", "cancelled", "unknown"].includes(String(event.status)) ? event.status as "completed" | "failed" | "cancelled" | "unknown" : "unknown";
      add(event, { kind: "tool_result", callId: event.toolUseId, parts: [{ type: "text", text: event.output, format: "plain" }], outcome,
        disclosure: event.truncated === true ? "truncated" : "complete",
        ...(typeof event.durationMs === "number" && Number.isFinite(event.durationMs) && event.durationMs >= 0 ? { durationMs: event.durationMs } : {}) }, { kind: "tool" });
    } else if (event.type === "result" || event.type === "error") {
      finish(event.type === "result" && event.status === "success" ? "complete" : "interrupted");
      if (event.type === "result" && event.usage && typeof event.usage === "object") {
        const counts = event.usage as Record<string, unknown>;
        const count = (key: string) => typeof counts[key] === "number" && Number.isSafeInteger(counts[key]) && Number(counts[key]) >= 0 ? Number(counts[key]) : undefined;
        add(event, { kind: "usage", scope: "turn", source: "provider-reported", inputTokens: count("inputTokens"), outputTokens: count("outputTokens"), estimated: false }, { kind: "system" });
      }
    }
  }
  if (["cancelled", "abandoned", "failed"].includes(record.status)) finish("interrupted");
  // Never silently clip a common entry. A caller receives an explicit bounds failure instead.
  return entries;
}
