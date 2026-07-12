// A Shell page served over https cannot embed an app UI served over plain http: browsers block
// the iframe as mixed content (Safari and Firefox even for loopback addresses), and the frame
// stays silently blank — the iframe fires neither load nor error. Detecting the combination up
// front lets the workspace render an actionable explanation instead. `pageProtocol` is
// window.location.protocol at the call site so the predicate stays pure and testable.
export function isInsecureEmbedBlocked(pageProtocol: string, src: string): boolean {
  if (pageProtocol !== "https:") {
    return false;
  }

  try {
    return new URL(src).protocol === "http:";
  } catch {
    // A relative src resolves against the (https) Shell origin, so it is never mixed content.
    return false;
  }
}

// Display origin for the blocked-embed explanation (e.g. "http://127.0.0.1:60944"), or the raw
// value when it is not an absolute URL.
export function getEmbedOrigin(src: string): string {
  try {
    return new URL(src).origin;
  } catch {
    return src;
  }
}

// Whether the embed target is a loopback address — reachable only from a browser running on the
// Hosty host itself, which the blocked-embed explanation calls out so remote users don't chase
// the "open in a new tab" escape hatch in vain.
export function isLoopbackEmbedHost(src: string): boolean {
  try {
    const host = new URL(src).hostname;
    // The whole 127.0.0.0/8 range is loopback, not just 127.0.0.1.
    return host === "localhost" || host === "::1" || host === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  } catch {
    return false;
  }
}
