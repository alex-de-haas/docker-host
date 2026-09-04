import { describe, expect, it } from "vitest";
import { takeChosenFiles } from "./attachments";

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
