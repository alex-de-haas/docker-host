// The Shell embeds Marketplace in a cross-origin iframe. We must post install intents to the exact
// Shell origin and accept theme messages only from it. document.referrer looks like the Shell on
// the first load, but AppIdentityBridge reloads the frame after the app-code exchange and a
// self-reload rewrites document.referrer to our OWN origin — so the referrer can't be trusted
// afterwards.
//
// The reliable signal is a message the parent actually sends us: the browser sets both
// event.source (=== window.parent) and event.origin. The Shell posts a theme message on every
// (re)load, so we learn — and relearn after the reload — the real embedding origin from it and
// persist it (survives the reload). The referrer is kept only as a best-effort fallback for the
// first paint before any parent message arrives, and is never persisted (persisting it is what
// previously poisoned this value with our own origin).
const STORAGE_KEY = "hosty.embedding.origin";

export function resolveEmbeddingOrigin(referrer: string): string | null {
  try {
    const url = new URL(referrer);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin !== "null"
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

function readStored(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const stored = window.sessionStorage.getItem(STORAGE_KEY);
    return stored && resolveEmbeddingOrigin(stored) ? stored : null;
  } catch {
    // sessionStorage can throw in blocked/partitioned contexts; fall back to the referrer.
    return null;
  }
}

// Record the embedder origin from a message the parent actually sent us (event.source ===
// window.parent). Overwrites any earlier value so a stale entry self-heals on the next load.
export function rememberParentOrigin(origin: string): void {
  if (!resolveEmbeddingOrigin(origin)) {
    return;
  }
  try {
    window.sessionStorage.setItem(STORAGE_KEY, origin);
  } catch {
    // best-effort; getEmbeddingOrigin still falls back to the referrer within this page's lifetime.
  }
}

export function getEmbeddingOrigin(): string | null {
  if (typeof document === "undefined") {
    return null;
  }
  return readStored() ?? resolveEmbeddingOrigin(document.referrer);
}

// Attach at module evaluation — before React mounts and before the iframe's load event — so we
// never miss the Shell's initial theme message, whose origin is exactly what we need to capture.
// Guarded so HMR re-evaluation (or a duplicate import) can't stack multiple listeners.
function listenForParentOrigin(): void {
  if (typeof window === "undefined" || window.parent === window) {
    return;
  }
  const host = window as Window & { __hostyEmbeddingOriginListener?: boolean };
  if (host.__hostyEmbeddingOriginListener) {
    return;
  }
  host.__hostyEmbeddingOriginListener = true;
  window.addEventListener("message", (event) => {
    if (event.source === window.parent) {
      rememberParentOrigin(event.origin);
    }
  });
}

listenForParentOrigin();
