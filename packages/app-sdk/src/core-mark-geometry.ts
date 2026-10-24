/** Canonical seven-cell platform mark, shared by web chrome and generated brand assets. */
export const CORE_MARK = {
  cells: ["X.X", "X*X", "X.X"],
  accent: "#A3E635",
  plain: { size: 22, gap: 7, inset: 10 },
  tile: { size: 16, gap: 5.5, inset: 20.5, radius: 22 },
} as const;

export const CORE_MARK_CELLS = CORE_MARK.cells;
