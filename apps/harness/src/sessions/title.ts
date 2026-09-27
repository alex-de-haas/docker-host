// How a session gets its name.
//
// The record has carried a `title` since the first version and nothing ever set one, so every row in
// the operator's session list read "Untitled session" — a list that cannot be scanned is a list that
// is only ever used to reach the newest entry. Three sources fill it, cheapest first, and none of
// them calls a model: a title that costs a round trip is a title that is missing whenever the
// harness is down, which is exactly when the operator is scrolling this list.
//
// A session record also carries `context` ({app, page}), which would name a session before a word
// was typed. Nothing fills it: since the panel moved out of Shell, "Ask assistant" appends to the
// composer draft instead of opening a context-seeded session, and no client sends the field. The
// draft it appends already opens with "From <app id>:", so the first-message rule names those
// sessions after their source anyway — a context branch here would be code nothing can reach.

/** Long enough to distinguish two sessions about the same app, short enough for a narrow panel. */
export const MAX_TITLE_CHARS = 80;

/**
 * A title from the operator's first message.
 *
 * The first line, not the first sentence: harnesses are asked questions in a form where the ask is
 * the opening line and the pasted log follows it, so a sentence-boundary rule would name the session
 * after a stack trace. A message with no usable text yields null and the session stays unnamed
 * rather than acquiring a name made of punctuation.
 */
export function deriveTitleFromMessage(text: string): string | null {
  const line = text
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => /[\p{L}\p{N}]/u.test(entry));
  return line ? truncateTitle(line.replace(/\s+/g, " ")) : null;
}

/**
 * Normalizes a title the operator typed. An emptied box is a decision — it clears the name and lets
 * the next message derive one again, rather than pinning the session to the empty string.
 */
export function normalizeTitle(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed ? truncateTitle(collapsed) : null;
}

/** Cuts at a word boundary where one is near the limit, so a title ends on a word, not mid-token. */
function truncateTitle(value: string): string {
  if (value.length <= MAX_TITLE_CHARS) {
    return value;
  }
  const cut = value.slice(0, MAX_TITLE_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > MAX_TITLE_CHARS * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
