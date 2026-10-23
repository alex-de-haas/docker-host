"use client";
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
const query = "(max-width: 899px)";
const readNarrow = () => window.matchMedia?.(query).matches ?? false;
const subscribe = (notify: () => void) => {
  const media = window.matchMedia?.(query); media?.addEventListener("change", notify);
  return () => media?.removeEventListener("change", notify);
};
const server = () => false;
export const useNarrowWorkspace = () => useSyncExternalStore(subscribe, readNarrow, server);

/** Layout changes only style this tree: moving it through a portal would lose local form state. */
export function RetainedWorkspacePane({ children, open, visible, reviewing, onClose }: {
  children: ReactNode; open: boolean; visible: boolean; reviewing: boolean; onClose: () => void;
}) {
  const narrow = useNarrowWorkspace();
  const modal = narrow && open && !reviewing;
  const pane = useRef<HTMLDivElement>(null), close = useRef<HTMLButtonElement>(null);
  const closeHandler = useRef(onClose); useEffect(() => { closeHandler.current = onClose; }, [onClose]);
  useEffect(() => {
    if (!modal) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    close.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      // Radix menus and dialogs render in their own managed focus scope outside this pane.
      if (event.defaultPrevented || (event.target instanceof Element && event.target.closest('[role="menu"], [role="listbox"], [data-slot="dialog-content"], [data-slot="popover-content"]'))) return;
      if (event.key === "Escape") { event.preventDefault(); closeHandler.current(); }
      if (event.key !== "Tab") return;
      const items = Array.from(pane.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? []).filter(item => item.getClientRects().length && !item.closest('[hidden], [inert]'));
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); if (opener?.isConnected && opener.getClientRects().length) opener.focus(); };
  }, [modal]);
  return <>
    {modal && <button type="button" tabIndex={-1} aria-label="Close workspace" className="fixed inset-0 z-30 bg-black/30" onClick={onClose} />}
    <div ref={pane} role={modal ? "dialog" : undefined} aria-modal={modal || undefined} aria-label={modal ? "Workspace" : undefined}
      className={cn("min-h-0 min-w-0 border-l min-[900px]:w-[344px] min-[900px]:flex-none", reviewing ? "hidden" : open ? "harness-workspace-sheet block" : "hidden", !reviewing && visible ? "min-[900px]:block" : "min-[900px]:hidden")}>
      {open && <div className="flex items-center justify-between border-b bg-background px-3 py-2 min-[900px]:hidden"><span className="text-sm font-medium">Workspace</span><Button ref={close} variant="ghost" size="sm" onClick={onClose}>Back to conversation</Button></div>}
      {children}
    </div>
  </>;
}
