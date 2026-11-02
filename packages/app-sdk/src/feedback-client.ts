import type { FeedbackConnection, FeedbackEvent, FeedbackOperation, FeedbackPort } from './feedback-channel';
export type { FeedbackDraft, DraftNote, FeedbackSource, FeedbackEvent, FeedbackOperation, FeedbackPort } from './feedback-channel';
export { feedbackScope, validDraft } from './feedback-channel';
export { captureStill, captureScreen, cropStill } from './feedback-capture';
let connect: FeedbackConnection | null = null;
const listeners = new Set<() => void>();
/** Internal root binding: no window globals and no credentials cross the channel. */
export function bindFeedbackClient(value: FeedbackConnection): () => void {
    connect = value;
    for (const listener of listeners)
        listener();
    return () => { if (connect === value) {
        connect = null;
        for (const listener of listeners)
            listener();
    } };
}
/** Reconnects after the UI root establishes or replaces its verified channel. */
export function connectFeedback(receive: (event: FeedbackEvent) => void): FeedbackPort {
    let port: FeedbackPort | null = null;
    const refresh = () => { port?.close(); port = connect?.(receive) ?? null; };
    listeners.add(refresh);
    refresh();
    return { request: (op: FeedbackOperation) => port?.request(op) ?? Promise.reject(new Error('Feedback tools require a connected workspace.')),
        close: () => { listeners.delete(refresh); port?.close(); } };
}
