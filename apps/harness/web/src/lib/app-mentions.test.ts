import { describe, expect, it } from "vitest";
import { editMentionDraft, insertMention, mentionQuery, serializeMentions } from "./app-mentions";
const app = { id: "com.haas.media", displayName: "Media Server" };
const original = { text: "Check @media tomorrow", mentions: [] };
const query = { start: 6, end: 12, search: "media" };

describe("app mention drafts", () => {
  it("uses the caret query without matching email addresses, selections or a confirmed mention", () => {
    expect(mentionQuery("@media", 6, 6, [])).toEqual({ start: 0, end: 6, search: "media" });
    expect(mentionQuery("see\n@media afterwards", 10, 10, [])?.search).toBe("media");
    expect(mentionQuery("a@media", 7, 7, [])).toBeNull();
    expect(mentionQuery("@media", 0, 6, [])).toBeNull();
    const draft = insertMention(original, query, app);
    expect(mentionQuery(draft.text, 8, 8, draft.mentions)).toBeNull();
  });
  it("inserts a stable readable reference at the caret and retains the suffix", () => {
    const draft = insertMention(original, query, app);
    expect(draft.text).toBe("Check @Media Server  tomorrow");
    expect(serializeMentions(draft)).toBe("Check @Media Server (com.haas.media)  tomorrow");
    expect(draft.text.slice(draft.mentions[0].start, draft.mentions[0].end)).toBe("@Media Server");
  });
  it("shifts untouched spans and drops identity on edits inside a mention", () => {
    const draft = insertMention(original, query, app);
    const shifted = editMentionDraft(draft, "Please " + draft.text);
    expect(shifted.mentions[0].start).toBe(draft.mentions[0].start + 7);
    expect(editMentionDraft(draft, draft.text.replace("Server", "Client")).mentions).toEqual([]);
    expect(editMentionDraft(draft, "").mentions).toEqual([]);
  });
  it("does not infer identity from typed or pasted lookalike text", () => {
    expect(editMentionDraft({ text: "", mentions: [] }, "@Media Server (com.haas.media)").mentions).toEqual([]);
  });
});
