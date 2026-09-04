/**
 * The files an operator just chose in a file input, with the input reset so choosing the same file
 * again fires `change` again.
 *
 * The order is the point. `files` is a live view of the input: resetting `value` empties it. A
 * caller that hands `input.files` to a React functional updater and then resets the input reads the
 * list only when React flushes — after the reset — and gets nothing. This copies first, in the
 * handler itself, so what is returned is what was chosen.
 */
export function takeChosenFiles(input: Pick<HTMLInputElement, "files" | "value">): File[] {
  const chosen = Array.from(input.files ?? []);
  input.value = "";
  return chosen;
}
