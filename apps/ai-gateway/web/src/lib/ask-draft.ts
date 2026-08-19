/** Longer than this and repeated asks would grow the draft without bound. */
export const MAX_DRAFT_CHARS = 16_000;

/**
 * Folds an app's ask into the operator's draft.
 *
 * Pure, and deliberately so: this is the whole of what an app's text is allowed to do, so it is
 * worth being able to state and test in one place. It returns a draft — it has no way to send one,
 * which is the guarantee the design rests on rather than a discipline someone must remember.
 *
 * - **Appended, never replacing.** The operator may be part-way through a message, and dropping
 *   their words to make room for an app's would be its own kind of theft.
 * - **Provenance first.** The operator has to be able to see everything the model will, including
 *   where it came from.
 * - **Bounded in total.** Each ask is capped by the embedder, but a loop of accepted asks is not;
 *   the oldest text is dropped so the operator keeps what they most recently saw.
 */
export function composeAskDraft(current: string, text: string, sourceAppId: string): string {
  const from = sourceAppId ? `From ${sourceAppId}: ` : "";
  const addition = `${from}${text}`;
  const combined = current ? `${current}\n\n${addition}` : addition;
  return combined.length <= MAX_DRAFT_CHARS ? combined : combined.slice(combined.length - MAX_DRAFT_CHARS);
}
