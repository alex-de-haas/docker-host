export type AppMention = { id: string; label: string; start: number; end: number };
export type MentionDraft = { text: string; mentions: AppMention[] };
export type MentionQuery = { start: number; end: number; search: string };

export function mentionText(app: { id: string; displayName: string }): string {
  return `@${app.displayName.replace(/[\r\n]/g, " ")}`;
}

export function mentionQuery(text: string, start: number, end: number, mentions: AppMention[]): MentionQuery | null {
  if (start !== end || mentions.some(mention => start > mention.start && start <= mention.end)) return null;
  const match = /(?:^|\s)@([^\s@]*)$/.exec(text.slice(0, start));
  return match ? { start: start - match[1].length - 1, end: start, search: match[1] } : null;
}

/** Only unchanged spans keep their identity. Pasted lookalike text is ordinary text. */
export function editMentionDraft(draft: MentionDraft, text: string): MentionDraft {
  if (draft.text === text) return draft;
  let start = 0;
  while (start < draft.text.length && start < text.length && draft.text[start] === text[start]) start++;
  let oldEnd = draft.text.length, newEnd = text.length;
  while (oldEnd > start && newEnd > start && draft.text[oldEnd - 1] === text[newEnd - 1]) { oldEnd--; newEnd--; }
  const delta = newEnd - oldEnd;
  return { text, mentions: draft.mentions.flatMap(mention => {
    if (mention.end <= start) return [mention];
    if (mention.start >= oldEnd) return [{ ...mention, start: mention.start + delta, end: mention.end + delta }];
    return [];
  }) };
}

export function insertMention(draft: MentionDraft, query: MentionQuery, app: { id: string; displayName: string }): MentionDraft {
  const label = mentionText(app);
  const text = draft.text.slice(0, query.start) + label + " " + draft.text.slice(query.end);
  const edited = editMentionDraft(draft, text);
  return { text, mentions: [...edited.mentions, { id: app.id, label, start: query.start, end: query.start + label.length }].sort((a, b) => a.start - b.start) };
}

/** UI names stay compact; outbound text also carries the stable identity. */
export function serializeMentions(draft: MentionDraft, start = 0, end = draft.text.length): string {
  let position = start;
  let result = "";
  for (const mention of draft.mentions) {
    if (mention.start < start || mention.end > end) continue;
    result += draft.text.slice(position, mention.end) + ` (${mention.id})`;
    position = mention.end;
  }
  return result + draft.text.slice(position, end);
}

export const MENTION_DRAFT_PREFIX = "hosty.assistant.mentions.";
export function readMentionDraft(sessionId: string, text: string): MentionDraft {
  try {
    const stored = JSON.parse(window.localStorage.getItem(MENTION_DRAFT_PREFIX + sessionId) ?? "null");
    if (stored?.text === text && Array.isArray(stored.mentions)) {
      let end = 0;
      const mentions = stored.mentions.filter((m: AppMention) => {
        if (!m || typeof m.id !== "string" || typeof m.label !== "string" || !Number.isInteger(m.start) || !Number.isInteger(m.end)
          || m.start < end || m.end <= m.start || m.end > text.length || text.slice(m.start, m.end) !== m.label) return false;
        end = m.end; return true;
      });
      return { text, mentions };
    }
  } catch { /* Draft metadata is optional when browser storage is unavailable. */ }
  return { text, mentions: [] };
}
export function writeMentionDraft(sessionId: string, draft: MentionDraft): void {
  try {
    if (!draft.mentions.length) window.localStorage.removeItem(MENTION_DRAFT_PREFIX + sessionId);
    else window.localStorage.setItem(MENTION_DRAFT_PREFIX + sessionId, JSON.stringify({ text: draft.text.slice(0, 32_000), mentions: draft.mentions.filter(m => m.end <= 32_000) }));
  } catch { /* The visible draft remains editable even when storage is full. */ }
}
