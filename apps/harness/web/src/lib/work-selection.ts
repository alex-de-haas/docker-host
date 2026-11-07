export type WorkSelection = { sessionId?: string; workspaceId?: string };
export const WORK_SELECTION_STORAGE_KEY = "hosty.harness.work.selection";

/** Both full-page routes share a selection; the compact assistant keeps its own session. */
export function readWorkSelection(pathname: string): WorkSelection | null {
  try {
    const stored = localStorage.getItem(WORK_SELECTION_STORAGE_KEY);
    if (stored !== null) {
      try {
        const value: unknown = JSON.parse(stored);
        if (value && typeof value === "object" && !Array.isArray(value)) {
          const selection = value as WorkSelection;
          if (typeof selection.sessionId === "string" && selection.sessionId) return { sessionId: selection.sessionId };
          if (typeof selection.workspaceId === "string" && selection.workspaceId) return { workspaceId: selection.workspaceId };
          // An explicit empty selection prevents resurrecting a deleted legacy conversation.
          if (Object.keys(value).length === 0) return {};
        }
      } catch { /* Recover a corrupt optional preference from the historical path below. */ }
    }
    const path = pathname.replace(/\/+$/, "");
    const legacy = localStorage.getItem(`hosty.harness.${path === "/chats" ? "chats" : "workspaces"}.session`);
    if (!legacy) return null;
    const selection = { sessionId: legacy };
    rememberWorkSelection(selection);
    return selection;
  } catch { return null; }
}

export function rememberWorkSelection(selection: WorkSelection) {
  try { localStorage.setItem(WORK_SELECTION_STORAGE_KEY, JSON.stringify(selection)); }
  catch { /* Navigation still works when browser storage is unavailable. */ }
}
