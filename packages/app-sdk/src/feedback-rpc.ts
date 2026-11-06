/** Bounded requests tied to a verified document generation by the caller. */
export class FeedbackRpc {
    private pending = new Map<string, {
        resolve(value: unknown): void;
        reject(error: Error): void;
        timer: ReturnType<typeof setTimeout>;
        owner: object;
    }>();
    request(owner: object, send: (id: string) => void): Promise<unknown> {
        if (this.pending.size >= 64)
            return Promise.reject(new Error('Too many pending capture requests.'));
        return new Promise((resolve, reject) => {
            const id = crypto.randomUUID(), timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Capture timed out. Select the application and retry.')); }, 120000);
            this.pending.set(id, { resolve, reject, timer, owner });
            try {
                send(id);
            }
            catch (e) {
                this.pending.delete(id);
                clearTimeout(timer);
                reject(e);
            }
        });
    }
    receive(owner: object, id: unknown, value: unknown, error: unknown) {
        if (typeof id !== 'string')
            return;
        const p = this.pending.get(id);
        if (!p || p.owner !== owner)
            return;
        this.pending.delete(id);
        clearTimeout(p.timer);
        if (typeof error === 'string')
            p.reject(new Error(error.slice(0, 4096)));
        else
            p.resolve(value);
    }
    clear(owner?: object) { for (const [id, p] of this.pending) {
        if (owner && owner !== p.owner)
            continue;
        this.pending.delete(id);
        clearTimeout(p.timer);
        p.reject(new Error('The capture connection changed. Reopen the application before retrying.'));
    } }
}
