"use client";

import type { PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useRef, useState } from "react";

// Close the previous flyout before the next one opens while moving along the rail.
const COMPACT_MENU_HOVER_OPEN_MS = 250;
const COMPACT_MENU_HOVER_CLOSE_MS = 200;

/** Shared mouse-hover behavior for compact app and Settings menus. */
export function useCompactMenu() {
  const [open, setOpen] = useState(false);
  // Whether the current open state came from the hover timer rather than click/keyboard: a hover
  // open must not steal focus, and a trigger click while hover-opened pins the menu instead of
  // toggling it closed — the user is completing the click the hover pre-empted.
  const hoverOpenedRef = useRef(false);
  // Set when the hover-close timer fires so onCloseAutoFocus skips Radix's focus return: mousing
  // away from a menu that never had focus must not yank focus (and a scroll) to the trigger.
  const hoverClosedRef = useRef(false);
  const openTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (openTimerRef.current !== null) window.clearTimeout(openTimerRef.current);
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    },
    [],
  );

  const cancelOpenTimer = () => {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
  };
  const cancelCloseTimer = () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  // Touch has no hover; its emulated pointerenter on tap must not race the click-open path.
  const handleHoverStart = (event: ReactPointerEvent) => {
    if (event.pointerType !== "mouse") return;
    cancelCloseTimer();
    if (open || openTimerRef.current !== null) return;
    openTimerRef.current = window.setTimeout(() => {
      openTimerRef.current = null;
      hoverOpenedRef.current = true;
      setOpen(true);
    }, COMPACT_MENU_HOVER_OPEN_MS);
  };
  const handleHoverEnd = (event: ReactPointerEvent) => {
    if (event.pointerType !== "mouse") return;
    cancelOpenTimer();
    // Only a hover-opened menu closes on hover-out. A click-opened or pinned one behaves like a
    // normal dropdown — outside click, Escape, or a selection closes it — and it took focus on
    // open, so an auto-close here would also strand that focus (the hover-close path suppresses
    // the focus return, which is only correct when the menu never had it).
    if (!open || !hoverOpenedRef.current || closeTimerRef.current !== null) return;
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      hoverOpenedRef.current = false;
      hoverClosedRef.current = true;
      setOpen(false);
    }, COMPACT_MENU_HOVER_CLOSE_MS);
  };

  return {
    menuProps: {
      open,
      modal: false,
      onOpenChange(next: boolean) {
        cancelOpenTimer();
        cancelCloseTimer();
        if (!next) hoverOpenedRef.current = false;
        setOpen(next);
      },
    },
    triggerProps: {
      onPointerEnter: handleHoverStart,
      onPointerLeave: handleHoverEnd,
      onPointerDown(event: ReactPointerEvent) {
        // A click after hover pins the menu instead of immediately closing it.
        if (open && hoverOpenedRef.current && event.button === 0 && !event.ctrlKey) {
          event.preventDefault();
          hoverOpenedRef.current = false;
        }
      },
    },
    contentProps: {
      onPointerEnter(event: ReactPointerEvent) {
        if (event.pointerType === "mouse") cancelCloseTimer();
      },
      onPointerLeave: handleHoverEnd,
      onOpenAutoFocus(event: Event) {
        if (hoverOpenedRef.current) event.preventDefault();
      },
      onCloseAutoFocus(event: Event) {
        if (hoverClosedRef.current) {
          hoverClosedRef.current = false;
          event.preventDefault();
        }
      },
    },
  };
}
