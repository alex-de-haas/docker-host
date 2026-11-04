"use client";
import { useEffect, useState, type RefObject } from "react";

export const COLUMN_DEFAULTS = { navigation: 264, details: 344 };
export const COLUMN_MIN = { navigation: 220, details: 280 };
export const COLUMN_MAX = { navigation: 480, details: 560 };
export const CONVERSATION_MIN = 320;
export const COLUMNS_STORAGE_KEY = "hosty.harness.conversation-columns";
export type ColumnWidths = typeof COLUMN_DEFAULTS;
export type ConversationColumn = keyof ColumnWidths;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export function readColumnWidths(value: string | null): ColumnWidths {
  try {
    const stored = JSON.parse(value ?? "null");
    const read = (key: ConversationColumn) => typeof stored?.[key] === "number" && Number.isFinite(stored[key])
      ? clamp(stored[key], COLUMN_MIN[key], COLUMN_MAX[key]) : COLUMN_DEFAULTS[key];
    return { navigation: read("navigation"), details: read("details") };
  } catch { return { ...COLUMN_DEFAULTS }; }
}

/** Fit the visible columns without replacing the user's preferred widths on a smaller surface. */
export function fitConversationColumns(width: number, preferred: ColumnWidths, details: boolean): ColumnWidths {
  if (!width) return preferred;
  const available = Math.max(0, width - CONVERSATION_MIN);
  if (!details) return { ...preferred, navigation: clamp(preferred.navigation, COLUMN_MIN.navigation, available) };
  const extra = preferred.navigation - COLUMN_MIN.navigation + preferred.details - COLUMN_MIN.details;
  const ratio = extra ? clamp((available - COLUMN_MIN.navigation - COLUMN_MIN.details) / extra, 0, 1) : 1;
  return {
    navigation: Math.round(COLUMN_MIN.navigation + (preferred.navigation - COLUMN_MIN.navigation) * ratio),
    details: Math.floor(COLUMN_MIN.details + (preferred.details - COLUMN_MIN.details) * ratio),
  };
}

export function useConversationColumns(showDetails: boolean, container: RefObject<HTMLDivElement | null>) {
  const [available, setAvailable] = useState(0);
  const [preferred, setPreferred] = useState<ColumnWidths>(COLUMN_DEFAULTS);
  useEffect(() => {
    const restore = () => {
      try { setPreferred(readColumnWidths(window.localStorage.getItem(COLUMNS_STORAGE_KEY))); } catch { /* Storage is optional. */ }
    };
    restore();
    const node = container.current;
    if (!node) return;
    const measure = () => setAvailable(Math.floor(node.getBoundingClientRect().width));
    measure();
    const observer = new ResizeObserver(measure); observer.observe(node);
    return () => observer.disconnect();
  }, [container]);
  const narrow = available > 0 && available < COLUMN_MIN.navigation + COLUMN_MIN.details + CONVERSATION_MIN;
  const detailsVisible = showDetails && !narrow;
  const widths = fitConversationColumns(available, preferred, detailsVisible);
  const maximum = {
    navigation: Math.max(COLUMN_MIN.navigation, Math.min(COLUMN_MAX.navigation, (available || Infinity) - CONVERSATION_MIN - (detailsVisible ? widths.details : 0))),
    details: Math.max(COLUMN_MIN.details, Math.min(COLUMN_MAX.details, (available || Infinity) - CONVERSATION_MIN - widths.navigation)),
  };
  const resize = (column: ConversationColumn, value: number) => {
    // Start from displayed widths so dragging one boundary does not move the other boundary.
    const next = { ...widths, [column]: Math.round(clamp(value, COLUMN_MIN[column], maximum[column])) };
    setPreferred(next);
    try { window.localStorage.setItem(COLUMNS_STORAGE_KEY, JSON.stringify(next)); } catch { /* Resizing still works without persistence. */ }
  };
  return { widths, maximum, narrow, resize };
}
