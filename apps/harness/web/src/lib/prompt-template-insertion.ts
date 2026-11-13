import type { MentionDraft } from "./app-mentions";

export type TemplateQuery = { start: number; end: number; search: string };

/** Ignore code while the operator is writing it, including an unfinished fence/span. */
function insideCode(text: string): boolean {
  let fence: { marker: string; length: number } | null = null;
  let ticks = 0;
  for (const line of text.split("\n")) {
    const boundary = /^[ \t]*(?:(?:>|[-+*] |\d+[.)] )[ \t]*)*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (boundary && boundary[1][0] === fence.marker && boundary[1].length >= fence.length && !boundary[2].trim()) fence = null;
      continue;
    }
    if (boundary && (boundary[1][0] === "~" || !boundary[2].includes("`"))) {
      fence = { marker: boundary[1][0], length: boundary[1].length }; ticks = 0; continue;
    }
    for (let i = 0; i < line.length; i++) {
      if (line[i] !== "`") continue;
      let escapes = 0;
      for (let j = i - 1; j >= 0 && line[j] === "\\"; j--) escapes++;
      if (!ticks && escapes % 2) continue;
      let end = i + 1;
      while (line[end] === "`") end++;
      const length = end - i;
      if (!ticks) ticks = length;
      else if (ticks === length) ticks = 0;
      i = end - 1;
    }
  }
  return !!fence || ticks > 0;
}

export function promptTemplateQuery(draft: MentionDraft, start: number, end: number): TemplateQuery | null {
  if (start !== end || start < 0 || end > draft.text.length) return null;
  const match = /(?:^|\s)!([a-z0-9_-]*)$/i.exec(draft.text.slice(0, start));
  if (!match) return null;
  const query = { start: start - match[1].length - 1, end: start, search: match[1] };
  if (draft.mentions.some(mention => query.start < mention.end && query.end > mention.start)
    || insideCode(draft.text.slice(0, query.start))) return null;
  return query;
}

export function templateQueryKey(query: TemplateQuery | null): string {
  return query ? `${query.start}:${query.end}:${query.search}` : "";
}

/** Literal insertion preserves identities only for untouched mentions, even for identical text. */
export function insertPromptTemplate(draft: MentionDraft, start: number, end: number, text: string): MentionDraft {
  const delta = text.length - (end - start);
  return {
    text: draft.text.slice(0, start) + text + draft.text.slice(end),
    mentions: draft.mentions.flatMap(mention => {
      if (mention.end <= start) return [mention];
      if (mention.start >= end) return [{ ...mention, start: mention.start + delta, end: mention.end + delta }];
      return [];
    }),
  };
}
