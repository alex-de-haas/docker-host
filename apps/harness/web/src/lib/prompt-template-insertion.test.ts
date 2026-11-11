import { expect, it } from "vitest";
import { insertPromptTemplate, promptTemplateQuery } from "./prompt-template-insertion";

it("finds case-insensitive shortcuts only at collapsed word boundaries", () => {
  for (const text of ["!", "!PR", "Review\n!pr", "Review !pr-review_2"]) {
    const query = promptTemplateQuery({ text, mentions: [] }, text.length, text.length);
    expect(query).toMatchObject({ end: text.length });
  }
  for (const text of ["word!pr", "https://example.test/!pr", "\\!pr", "!pr.", "!pr rest"]) {
    expect(promptTemplateQuery({ text, mentions: [] }, text.length, text.length)).toBeNull();
  }
  expect(promptTemplateQuery({ text: "!pr", mentions: [] }, 0, 3)).toBeNull();
});

it("ignores inline/fenced code including unfinished spans and longer fence delimiters", () => {
  for (const text of ["`!pr", "``x ` !pr", "```ts\n!pr", "~~~\n!pr", "````\n```\n!pr", "`code\n!pr", "> ~~~\n> !pr", "- ~~~\n  !pr"]) {
    expect(promptTemplateQuery({ text, mentions: [] }, text.length, text.length), text).toBeNull();
  }
  for (const text of ["`code` !pr", "```ts\ncode\n```\n!pr", "~~~~\ncode\n~~~~\n!pr", "\\` !pr"]) {
    expect(promptTemplateQuery({ text, mentions: [] }, text.length, text.length), text).not.toBeNull();
  }
});

it("replaces the alias verbatim and retains untouched mention identities on both sides", () => {
  const draft = { text: "@First !pr @Last", mentions: [
    { id: "first", label: "@First", start: 0, end: 6 }, { id: "last", label: "@Last", start: 11, end: 16 },
  ] };
  const text = "Проверь PR\n@literal /command";
  const next = insertPromptTemplate(draft, 7, 10, text);
  expect(next.text).toBe(`@First ${text} @Last`);
  expect(next.mentions).toEqual([draft.mentions[0], { ...draft.mentions[1], start: 8 + text.length, end: 13 + text.length }]);
  expect(next.mentions).toHaveLength(2);
});

it("drops identities touched by a selection, even when their text is identical", () => {
  const draft = { text: "@App", mentions: [{ id: "app", label: "@App", start: 0, end: 4 }] };
  expect(insertPromptTemplate(draft, 0, 4, "@App").mentions).toEqual([]);
  expect(insertPromptTemplate(draft, 2, 2, "literal").mentions).toEqual([]);
  expect(promptTemplateQuery({ text: "@App !pr", mentions: [{ ...draft.mentions[0], end: 8 }] }, 8, 8)).toBeNull();
});
