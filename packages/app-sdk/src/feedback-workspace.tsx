"use client";
import { useContext, useState, useSyncExternalStore } from 'react';
import { UiHostContext } from './ui-context';
import { EMPTY_FEEDBACK } from './feedback-channel';
const noop = () => () => { };
export function useHostyFeedback() {
    const host = useContext(UiHostContext), feedback = host?.feedback;
    const state = useSyncExternalStore(feedback?.subscribe ?? noop, feedback?.getSnapshot ?? (() => EMPTY_FEEDBACK), () => EMPTY_FEEDBACK);
    return { host, feedback, state };
}
/** Optional host chrome shortcut. The form is always an ordinary app-provided tool. */
export function HostyFeedbackLauncher({ workspaceId = 'default', className }: {
    workspaceId?: string;
    className?: string;
}) {
    const host = useContext(UiHostContext);
    const snapshot = useSyncExternalStore(host?.subscribeSnapshot ?? noop, host?.getSnapshot ?? (() => null), () => null);
    const providers = snapshot?.catalog.filter(p => p.feedbackComposer) ?? [];
    const [error, setError] = useState('');
    if (!providers.length)
        return null;
    return <><button type="button" className={className} aria-label="Feedback" title="Feedback" onClick={() => {
            setError('');
            const operation = providers.length === 1 ? host?.selectPanel(providers[0]!.panel, workspaceId) : host?.openToolPicker({ requestId: crypto.randomUUID() });
            void operation?.then(result => { if (result.status !== 'opened' && result.status !== 'accepted')
                setError('Could not open the Feedback tool.'); }).catch(e => setError(e.message));
        }}><svg aria-hidden viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5a9.5 9.5 0 0 1 19 0Z"/></svg></button>{error && <span role="alert">{error}</span>}</>;
}
