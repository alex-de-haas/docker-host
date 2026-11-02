import type { FeedbackCapabilities, FeedbackNoteInput, FeedbackTarget } from './feedback-types';
export const FEEDBACK_CAPABILITY = 'feedback.capture.v2';
export const FEEDBACK_ROOT = 'host';
export type DraftNote = Omit<FeedbackNoteInput, 'image'> & {
    image?: Blob;
};
export type FeedbackDraft = {
    key: string;
    revision: number;
    requestId: string;
    comment: string;
    annotations: DraftNote[];
    submitting: boolean;
};
export type FeedbackSource = {
    id: string;
    capabilities: FeedbackCapabilities;
    label: string;
    route: string;
    workspaceId: string;
};
export type FeedbackOperation = {
    action: 'sources' | 'pick' | 'cancel' | 'page' | 'highlight' | 'crop-target' | 'legacy-read' | 'legacy-delete' | 'submit';
    sourceId?: string;
    mode?: 'element' | 'region';
    target?: FeedbackTarget;
    draft?: FeedbackDraft;
    requestId?: string;
    revision?: number;
};
export type FeedbackEvent = {
    type: 'sources';
    sources: FeedbackSource[];
} | {
    type: 'selection';
    source: FeedbackSource;
    note: DraftNote;
} | {
    type: 'picking';
    mode: 'element' | 'region' | null;
};
export type FeedbackPort = {
    request(operation: FeedbackOperation): Promise<unknown>;
    close(): void;
};
export type FeedbackConnection = (receive: (event: FeedbackEvent) => void) => FeedbackPort;
type Source = FeedbackSource & {
    visible(): boolean;
    invoke(operation: FeedbackOperation): Promise<unknown>;
};
type Composer = {
    workspaceId: string;
    visible(): boolean;
    receive(event: FeedbackEvent): void;
};
export const EMPTY_FEEDBACK = { picking: false, pickMode: undefined as 'element' | 'region' | undefined };
export function feedbackScope(c: FeedbackCapabilities) { return JSON.stringify([c.coreId, c.appId, c.installation, c.userId]); }
export function validCapabilities(value: unknown): value is FeedbackCapabilities {
    if (!value || typeof value !== 'object')
        return false;
    const c = value as FeedbackCapabilities;
    return c.version === 1 && [c.coreId, c.appId, c.installation, c.userId].every(s => typeof s === 'string' && s.length > 0 && s.length <= 512)
        && c.maxAnnotations > 0 && c.maxAnnotations <= 20 && c.maxImageBytes > 0 && c.maxImageBytes <= 2097152 && c.maxTotalImageBytes > 0 && c.maxTotalImageBytes <= 8388608;
}
export function validTarget(t: unknown): t is FeedbackTarget {
    if (!t || typeof t !== 'object')
        return false;
    const v = t as FeedbackTarget;
    return ['page', 'element', 'region'].includes(v.kind) && (v.label === undefined || typeof v.label === 'string' && v.label.length <= 200)
        && (v.selector === undefined || typeof v.selector === 'string' && v.selector.length <= 2048)
        && (!v.bounds || ['x', 'y', 'width', 'height'].every(k => Number.isFinite(v.bounds![k as keyof typeof v.bounds])))
        && (!v.viewport || ['width', 'height', 'scale'].every(k => Number.isFinite(v.viewport![k as keyof typeof v.viewport])));
}
export function validDraft(value: unknown): value is FeedbackDraft {
    if (!value || typeof value !== 'object')
        return false;
    const d = value as FeedbackDraft;
    if (typeof d.key !== 'string' || d.key.length > 4096 || typeof d.requestId !== 'string' || d.requestId.length > 128 || !d.requestId
        || !Number.isSafeInteger(d.revision) || d.revision < 0 || typeof d.submitting !== 'boolean' || typeof d.comment !== 'string' || d.comment.length > 5000
        || !Array.isArray(d.annotations) || d.annotations.length > 20)
        return false;
    let bytes = 0;
    return d.annotations.every(n => {
        if (!n || typeof n.id !== 'string' || n.id.length > 128 || typeof n.text !== 'string' || n.text.length > 2000 || typeof n.route !== 'string' || n.route.length > 8192
            || typeof n.capturedAt !== 'string' || !Number.isFinite(Date.parse(n.capturedAt)) || n.target && !validTarget(n.target))
            return false;
        if (n.image) {
            if (!(n.image instanceof Blob) || !['image/png', 'image/jpeg'].includes(n.image.type) || n.image.size > 2097152)
                return false;
            bytes += n.image.size;
        }
        return bytes <= 8388608;
    });
}
export function feedbackOperation(value: unknown): value is FeedbackOperation {
    if (!value || typeof value !== 'object')
        return false;
    const o = value as FeedbackOperation;
    return ['sources', 'pick', 'cancel', 'page', 'highlight', 'crop-target', 'legacy-read', 'legacy-delete', 'submit'].includes(o.action)
        && (o.sourceId === undefined || typeof o.sourceId === 'string' && o.sourceId.length <= 512)
        && (o.mode === undefined || ['element', 'region'].includes(o.mode)) && (o.target === undefined || validTarget(o.target))
        && (o.requestId === undefined || typeof o.requestId === 'string' && o.requestId.length <= 128)
        && (o.revision === undefined || Number.isSafeInteger(o.revision) && o.revision >= 0)
        && (o.draft === undefined || validDraft(o.draft));
}
/** Mounted, verified documents only. Form state never lives in this broker. */
export class FeedbackHost {
    private sources = new Map<string, Source>();
    private composers = new Map<string, Composer>();
    private listeners = new Set<() => void>();
    private delivered = new Map<string,string>();
    private snapshot = EMPTY_FEEDBACK;
    private picking: {
        owner: string;
        generation: number;
        ids: string[];
    } | null = null;
    private generation = 0;
    getSnapshot = () => this.snapshot;
    subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
    refresh = () => {
        for (const [id, composer] of this.composers) {
            const sources = this.available(id), serialized = JSON.stringify(sources);
            if (this.delivered.get(id) === serialized) continue;
            this.delivered.set(id, serialized);
            composer.receive({ type: 'sources', sources });
        }
        if (this.picking && !this.composers.get(this.picking.owner)?.visible()) this.cancel();
    };
    private publish() { this.refresh(); for (const listener of this.listeners) listener(); }
    register(source: Source) {
        const current = this.sources.get(source.id);
        if (current && feedbackScope(current.capabilities) === feedbackScope(source.capabilities) && current.route === source.route && current.workspaceId === source.workspaceId)
            Object.assign(current, source);
        else
            this.sources.set(source.id, source);
        this.publish();
    }
    removeSource(id: string) { if (this.picking?.ids.includes(id))
        this.cancel(); this.sources.delete(id); this.publish(); }
    remove(id: string) { this.disconnect(id); this.removeSource(id); }
    clear() { this.cancel(); this.sources.clear(); this.publish(); this.composers.clear(); }
    connect(id: string, composer: Composer): FeedbackPort {
        this.disconnect(id);
        this.composers.set(id, composer);
        this.refresh();
        return { request: o => this.request(id, o), close: () => this.disconnect(id) };
    }
    disconnect(id: string) { if (this.picking?.owner === id)
        this.cancel(); this.composers.delete(id); this.delivered.delete(id); }
    private available(id: string): FeedbackSource[] {
        const c = this.composers.get(id);
        if (!c?.visible())
            return [];
        return [...this.sources.values()].filter(s => s.visible() && (c.workspaceId === 'default' || c.workspaceId === s.workspaceId))
            .map(({ visible: _visible, invoke: _invoke, ...s }) => s);
    }
    cancel() {
        const pick = this.picking;
        this.picking = null;
        ++this.generation;
        this.snapshot = EMPTY_FEEDBACK;
        if (pick) {
            for (const id of pick.ids)
                void this.sources.get(id)?.invoke({ action: 'cancel' }).catch(() => { });
            this.composers.get(pick.owner)?.receive({ type: 'picking', mode: null });
        }
        for (const l of this.listeners)
            l();
    }
    async request(id: string, operation: FeedbackOperation): Promise<unknown> {
        if (!feedbackOperation(operation) || !this.composers.get(id)?.visible())
            throw new Error('Open a declared Feedback tool to collect feedback.');
        if (operation.action === 'sources')
            return this.available(id);
        if (operation.action === 'cancel') {
            if (this.picking?.owner === id)
                this.cancel();
            return null;
        }
        const allowed = this.available(id);
        if (operation.action === 'pick') {
            this.cancel();
            const candidates = allowed.filter(s => operation.mode === 'element' || s.id === operation.sourceId);
            if (!candidates.length)
                throw new Error('Open the application before selecting an element.');
            const generation = ++this.generation;
            this.picking = { owner: id, generation, ids: candidates.map(s => s.id) };
            this.snapshot = { picking: true, pickMode: operation.mode ?? 'element' };
            this.composers.get(id)?.receive({ type: 'picking', mode: operation.mode ?? 'element' });
            for (const l of this.listeners)
                l();
            for (const s of candidates)
                void this.sources.get(s.id)!.invoke(operation).then(value => {
                    if (this.picking?.generation !== generation)
                        return;
                    if (!value) {
                        this.cancel();
                        return;
                    }
                    if (!this.available(id).some(a => a.id === s.id) || !validDraft({ key: '', revision: 0, requestId: 'selection', comment: '', submitting: false, annotations: [value] })) {
                        this.cancel();
                        return;
                    }
                    this.cancel();
                    this.composers.get(id)?.receive({ type: 'selection', source: s, note: value as DraftNote });
                }).catch(() => { if (this.picking?.generation === generation)
                    this.cancel(); });
            return null;
        }
        const source = this.sources.get(operation.sourceId ?? '');
        if (!source || !allowed.some(s => s.id === source.id))
            throw new Error('This application is no longer visible in the workspace.');
        if (operation.action === 'submit' && (!operation.draft || operation.draft.key !== feedbackScope(source.capabilities)))
            throw new Error('Feedback belongs to a different application or account.');
        const composer = this.composers.get(id);
        const value = await source.invoke(operation);
        if (this.composers.get(id) !== composer || this.sources.get(source.id) !== source || !this.available(id).some(s => s.id === source.id))
            throw new Error('The source document changed. Reopen it before retrying.');
        if (operation.action === 'legacy-read' && value !== null && (!validDraft(value) || value.key !== feedbackScope(source.capabilities)))
            throw new Error('The source returned an invalid recovery draft.');
        if (operation.action === 'page' && !validDraft({key:'',revision:0,requestId:'page',comment:'',submitting:false,annotations:[value]}))
            throw new Error('The source returned invalid page context.');
        return value;
    }
}
