import { describe, expect, it } from "vitest";
import { indexAttachments, takeChosenFiles } from "./attachments";

describe("takeChosenFiles", () => {
  it("returns the selection and resets the input, in that order", () => {
    // The bug this pins: the composer read `files` inside a functional state updater, which runs
    // after the handler returns — and the handler had already reset the input. Every selection
    // appended nothing. Modelled with a live list that empties on reset, as a real input's does.
    const one = new File(["a"], "one.txt");
    const two = new File(["b"], "two.txt");
    let files: File[] = [one, two];
    const input = {
      get files() {
        return files as unknown as FileList;
      },
      set value(_: string) {
        files = [];
      },
      get value() {
        return "";
      },
    };

    const chosen = takeChosenFiles(input);

    expect(chosen).toEqual([one, two]);
    // Reset happened — the same file chosen again must fire change again.
    expect(input.files).toHaveLength(0);
    // And the copy survived it: a caller reading `chosen` later still has both.
    expect(chosen).toHaveLength(2);
  });

  it("returns nothing for an input with no selection", () => {
    const input = { files: null, value: "x" } as unknown as Pick<HTMLInputElement, "files" | "value">;

    expect(takeChosenFiles(input)).toEqual([]);
  });
});

// Which message a file belongs to, when the two events are not neighbours. This is the whole reason
// the index exists: the transcript used to say "the upload above this message is this message's",
// which is true right up until the message that claims a file is not the next event.
describe("indexAttachments", () => {
  const upload = (seq: number, name: string, size: number) =>
    ({ seq, ts: "", type: "attachment_added", name, size });
  const message = (seq: number, text: string, attachments?: string[]) =>
    ({ seq, ts: "", type: "user_message", text, ...(attachments ? { attachments } : {}) });

  it("claims a file for the message that names it, however far away the upload is", () => {
    const index = indexAttachments([
      upload(1, "notes.txt", 5),
      { seq: 2, ts: "", type: "assistant_text", text: "anything at all" },
      { seq: 3, ts: "", type: "error", message: "the send that failed" },
      message(4, "read this", ["notes.txt"]),
    ]);

    expect(index.claimed.has("notes.txt")).toBe(true);
    // The size still comes from the upload event, so the message can show it without the file.
    expect(index.sizes.get("notes.txt")).toBe(5);
  });

  it("leaves an upload no message named unclaimed, so it keeps a row of its own", () => {
    const index = indexAttachments([upload(1, "stray.txt", 9), message(2, "unrelated")]);

    expect(index.claimed.has("stray.txt")).toBe(false);
    expect(index.sizes.get("stray.txt")).toBe(9);
  });

  it("claims a file for every message that names it", () => {
    // A client may name a file an earlier turn stored. Both messages show it; the upload row, which
    // belongs to neither, shows nothing.
    const index = indexAttachments([
      upload(1, "spec.pdf", 12),
      message(2, "first", ["spec.pdf"]),
      message(3, "again", ["spec.pdf"]),
    ]);

    expect(index.claimed.has("spec.pdf")).toBe(true);
  });

  it("claims a name whose upload event the log no longer holds", () => {
    // Trimmed logs and restored sessions both produce this. The name is still drawn on its message;
    // only the size is unknown, and the row omits it rather than inventing a zero.
    const index = indexAttachments([message(1, "read this", ["gone.txt"])]);

    expect(index.claimed.has("gone.txt")).toBe(true);
    expect(index.sizes.has("gone.txt")).toBe(false);
  });
});
