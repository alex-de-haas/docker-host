import type { SVGProps } from "react";

import { CORE_MARK, CORE_MARK_CELLS } from "./core-mark-geometry";

export { CORE_MARK_CELLS } from "./core-mark-geometry";

export function CoreMark(props: SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 100 100" fill="currentColor" aria-hidden="true" focusable="false" {...props}>
    {CORE_MARK_CELLS.flatMap((row, y) => [...row].map((cell, x) => cell === "." ? null :
      <rect key={`${x}:${y}`} x={CORE_MARK.plain.inset + x * (CORE_MARK.plain.size + CORE_MARK.plain.gap)}
        y={CORE_MARK.plain.inset + y * (CORE_MARK.plain.size + CORE_MARK.plain.gap)}
        width={CORE_MARK.plain.size} height={CORE_MARK.plain.size} fill={cell === "*" ? CORE_MARK.accent : "currentColor"} />))}
  </svg>;
}
