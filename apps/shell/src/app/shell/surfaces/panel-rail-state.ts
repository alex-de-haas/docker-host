/** Activating the selected tool toggles its body; another tool always opens. */
export function activatePanel(key: string, activeKey: string | null, expanded: boolean) {
  return { key, expanded: key !== activeKey || !expanded };
}

/** Focus navigation never activates a panel or launches its iframe. */
export function panelFocusIndex(key: string, index: number, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case "ArrowDown": return (index + 1) % count;
    case "ArrowUp": return (index - 1 + count) % count;
    case "Home": return 0;
    case "End": return count - 1;
    default: return null;
  }
}
