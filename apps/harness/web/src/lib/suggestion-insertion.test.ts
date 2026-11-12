import { beforeEach, expect, it, vi } from "vitest";
import { SuggestionInsertion, insertionScope, type SuggestionInsertionIntent } from "./suggestion-insertion";

let values: Map<string, string>;
const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
const controller = () => new SuggestionInsertion(insertionScope("https://host.test", "owner", "conversation"), "conversation", storage);
const value = { suggestionId: "suggestion", revision: 1, text: "Review @app literally" };
let insertion: SuggestionInsertion;
beforeEach(() => { values = new Map(); insertion = controller(); });

it("persists the operation identity before selection and retains exactly one editable draft", () => {
  const intent = insertion.stage(value); const reloaded = controller();
  expect(reloaded.read()).toEqual(intent);
  const selected = reloaded.selected(intent), insert = vi.fn(() => true);
  expect(reloaded.apply(selected, insert)).toBe("inserted");
  expect(insert).toHaveBeenCalledExactlyOnceWith(value.text);
  expect(storage.getItem("hosty.assistant.draft.conversation")).toBe(value.text);
  expect(reloaded.read()).toBeNull();
});
it("never overwrites a changed or cleared draft after selection acknowledgement", () => {
  const intent = insertion.selected(insertion.stage(value)); insertion.changed();
  storage.setItem("hosty.assistant.draft.conversation", "my draft");
  const insert = vi.fn(() => true);
  expect(insertion.apply(intent, insert)).toBe("draft-changed");
  storage.setItem("hosty.assistant.draft.conversation", "");
  expect(controller().apply(intent, insert)).toBe("draft-changed"); expect(insert).not.toHaveBeenCalled();
  expect(insertion.apply(insertion.retry(intent), insert)).toBe("inserted");
});
it("recovers a crash between persisted draft and intent acknowledgement without inserting twice", () => {
  const intent = insertion.selected(insertion.stage(value));
  storage.setItem("hosty.assistant.draft.conversation", value.text);
  const insert = vi.fn(() => true);
  expect(controller().apply(intent, insert)).toBe("restored"); expect(insert).not.toHaveBeenCalled();
  expect(controller().read()).toBeNull();
});
it("keeps a refused editor insertion recoverable and suppresses its own draft-change notification", () => {
  const intent = insertion.selected(insertion.stage(value));
  expect(insertion.apply(intent, () => false)).toBe("refused");
  expect(storage.getItem("hosty.assistant.draft.conversation")).toBe("");
  expect(insertion.read()?.state).toBe("selected");
  expect(insertion.apply(intent, () => { insertion.changed(); return true; })).toBe("inserted");
});
it("does not proceed without durable local intent storage and scopes identities by installation/user/session", () => {
  const broken = new SuggestionInsertion("scope", "conversation", { ...storage, setItem: () => { throw new Error("quota"); } });
  expect(() => broken.stage(value)).toThrow("quota");
  expect(new Set([insertionScope("https://one", "owner", "chat"), insertionScope("https://two", "owner", "chat"), insertionScope("https://one", "another", "chat"), insertionScope("https://one", "owner", "other")]).size).toBe(4);
});
it("retains a dismissal's exact identity for uncertain-reply recovery without creating insertion work", () => {
  const intent = insertion.stage(value, "dismissed");
  expect(controller().read()).toEqual(intent); expect(intent.action).toBe("dismissed");
  insertion.forget(intent as SuggestionInsertionIntent); expect(controller().read()).toBeNull();
});
