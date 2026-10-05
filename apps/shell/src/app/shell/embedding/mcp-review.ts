/** The frame chooses a target; only its mounted identity determines the assistant being reviewed. */
export function mcpReviewRequest(event: MessageEvent, frame: Window | null | undefined, src: string, appId: string) {
  if (!frame || event.source !== frame || !event.data || event.data.type !== "hosty:request-mcp-review") return null;
  try { if (event.origin !== new URL(src).origin) return null; } catch { return null; }
  const target = event.data.targetAppId;
  if (typeof target !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/.test(target)) return null;
  return { appId, targetAppId: target };
}
