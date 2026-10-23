import type { CSSProperties } from "react";

const marks: Record<string, { cells: string[]; accent: string }> = {
  "hosty.core": { cells: ["X.X", "X*X", "X.X"], accent: "#A3E635" },
  "hosty.shell": { cells: ["XX.", "X*X", ".XX"], accent: "#22D3EE" },
  "hosty.harness": { cells: [".X.", "X*X", "X.X"], accent: "#FB923C" },
  "hosty.marketplace": { cells: ["XXX", "X*X", "X.X"], accent: "#FACC15" },
};

export function hasHostyMark(appId?: string): boolean { return !!appId && !!marks[appId]; }

export function HostyMark({ appId = "hosty.core", tile = false, className, label }: {
  appId?: string; tile?: boolean; className?: string; label?: string;
}) {
  const mark = marks[appId] ?? marks["hosty.core"];
  const size = tile ? 16 : 22, gap = tile ? 5.5 : 7, inset = tile ? 20.5 : 10;
  return <svg viewBox="0 0 100 100" className={className} role={label ? "img" : undefined}
    aria-label={label} aria-hidden={label ? undefined : true} style={{ "--mark-accent": mark.accent } as CSSProperties}>
    {tile && <rect width="100" height="100" rx="22" className="fill-[#0F1B2D] dark:fill-[#22324B]" />}
    {mark.cells.flatMap((row, y) => [...row].map((cell, x) => cell === "." ? null :
      <rect key={`${x}:${y}`} x={inset + x * (size + gap)} y={inset + y * (size + gap)} width={size} height={size}
        fill={cell === "*" ? mark.accent : tile ? "white" : "currentColor"} />))}
  </svg>;
}
