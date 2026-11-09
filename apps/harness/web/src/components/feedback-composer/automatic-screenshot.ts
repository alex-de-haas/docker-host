"use client";
import { useCallback, useEffect, useRef, useState } from 'react';
import { captureScreen, type DraftNote, type FeedbackEvent, type FeedbackOperation, type FeedbackSource } from '@hosty-sdk/app/feedback/client';

type Selection = { source: FeedbackSource; note: DraftNote };
export type AutomaticScreenshot = Selection & { blob: Blob };
type Request = (operation: FeedbackOperation) => Promise<unknown>;
type Capture = {
    abort: AbortController;
    owner: FeedbackSource;
    started: boolean;
    selection?: Selection;
    resolve: (selection: Selection) => void;
    timeout?: ReturnType<typeof setTimeout>;
};
const failure = (error: unknown) => error instanceof Error ? error.message : 'Screen capture is unavailable.';

/** The form owns this short capture session; the SDK source owns the outline and annotation. */
export function useAutomaticScreenshot(request: Request) {
    const [enabled, setEnabled] = useState(true);
    const [phase, setPhase] = useState<'permission' | 'selection' | 'capture' | null>(null);
    const [notice, setNotice] = useState('');
    const [result, setResult] = useState<AutomaticScreenshot | null>(null);
    const active = useRef<Capture | null>(null);
    const clearResult = useCallback(() => setResult(null), []);
    const stop = useCallback(() => {
        const capture = active.current;
        active.current = null;
        if (capture) { clearTimeout(capture.timeout); capture.abort.abort(); }
    }, []);
    const cancel = useCallback(() => { stop(); setPhase(null); }, [stop]);
    useEffect(() => stop, [stop]);
    const receive = useCallback((event: FeedbackEvent) => {
        const capture = active.current;
        if (!capture) return;
        if (event.type === 'selection') {
            if (event.source.capabilities.userId !== capture.owner.capabilities.userId || event.source.capabilities.coreId !== capture.owner.capabilities.coreId) {
                cancel(); return;
            }
            capture.selection = { source: event.source, note: event.note }; capture.resolve(capture.selection);
            return true;
        }
        if (event.type === 'picking' && event.mode === null && capture.started && !capture.selection) cancel();
        if (event.type === 'sources') {
            const target = capture.selection?.source;
            if (!event.sources.length || event.sources.some(s => s.capabilities.userId !== capture.owner.capabilities.userId || s.capabilities.coreId !== capture.owner.capabilities.coreId) ||
                (target && !event.sources.some(s => s.id === target.id && s.route === target.route && s.capabilities.installation === target.capabilities.installation))) cancel();
        }
    }, [cancel]);

    async function start(mode: 'element' | 'region' | 'page', source: FeedbackSource, pageSelected: (event: Selection) => void) {
        if (active.current) return;
        setNotice(''); setResult(null);
        if (!enabled) {
            try {
                if (mode === 'page') pageSelected({ source, note: await request({ action: 'page', sourceId: source.id }) as DraftNote });
                else await request({ action: 'pick', mode, sourceId: source.id });
            } catch (error) { setNotice(failure(error)); }
            return;
        }
        let resolve!: (selection: Selection) => void;
        const selection = new Promise<Selection>(done => { resolve = done; });
        const capture: Capture = { abort: new AbortController(), owner: source, started: false, resolve };
        active.current = capture; setPhase('permission');
        capture.timeout = setTimeout(() => {
            if (active.current !== capture) return;
            cancel();
            setNotice('Screenshot selection timed out. You can try again or continue without a screenshot.');
            void request({ action: 'cancel' }).catch(() => {});
        }, 120000);
        let outlined: FeedbackSource | undefined;
        const begin = async () => {
            capture.abort.signal.throwIfAborted(); capture.started = true;
            if (mode === 'page') {
                const event = { source, note: await request({ action: 'page', sourceId: source.id }) as DraftNote };
                capture.abort.signal.throwIfAborted(); capture.selection = event; resolve(event);
            } else await request({ action: 'pick', mode, sourceId: source.id });
        };
        try {
            // Called directly from the button gesture, before any broker request or asynchronous work.
            const blob = await captureScreen(capture.abort.signal, async () => {
                if (active.current !== capture) return;
                setPhase('selection'); await begin();
                const chosen = await selection;
                capture.abort.signal.throwIfAborted(); setPhase('capture');
                if (chosen.note.target?.bounds) {
                    outlined = chosen.source;
                    await request({ action: 'highlight', sourceId: chosen.source.id, target: chosen.note.target, requestId: chosen.note.id });
                }
            });
            if (active.current === capture && capture.selection) setResult({ ...capture.selection, blob });
        } catch (error) {
            if (active.current === capture && !capture.abort.signal.aborted) {
                setNotice('Screenshot not captured: ' + failure(error) + ' You can continue with a comment.');
                if (!capture.started) {
                    try { await begin(); } catch (reason) { setNotice(failure(reason)); }
                }
            }
        } finally {
            clearTimeout(capture.timeout);
            if (outlined) void request({ action: 'highlight', sourceId: outlined.id }).catch(() => {});
            if (active.current === capture) {
                // Keep the selected DOM intact until its screenshot is captured, including feedback
                // on this form when switching the source would replace its editor.
                if (capture.selection) pageSelected(capture.selection);
                active.current = null; setPhase(null);
            }
        }
    }
    return { enabled, setEnabled, phase, notice, result, clearResult, cancel, receive, start };
}
