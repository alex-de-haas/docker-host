import { Tiktoken } from "js-tiktoken/lite";
import ranks from "js-tiktoken/ranks/o200k_base";

// Bounded chunks also bound BPE's worst-case work on long unbroken strings. Chunk boundaries
// are another approximation; never advertise these counts as model-exact tokenization.
export const MAX_ESTIMATE_BYTES = 128 * 1024;
let encoder: Tiktoken | undefined;
export function estimateLocalTokens(text: string): number | undefined {
  if (text.length > MAX_ESTIMATE_BYTES || new TextEncoder().encode(text).length > MAX_ESTIMATE_BYTES) return undefined;
  encoder ??= new Tiktoken(ranks);
  let tokens = 0;
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + 1024, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    tokens += encoder.encode(text.slice(start, end), [], []).length;
    start = end;
  }
  return tokens;
}
