/** App-owned Demo cell artwork matches the manifest mark, independent of runtime identifiers. */
export function DemoMark({ className, tile = false }: { className?: string; tile?: boolean }) {
  const size = tile ? 16 : 22, step = tile ? 21.5 : 29, inset = tile ? 20.5 : 10;
  const cells = [[0, 0], [1, 0], [0, 1], [1, 1], [2, 1], [0, 2], [1, 2]];
  return <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
    {tile && <rect className="demo-mark-tile" width="100" height="100" rx="22" />}
    {cells.map(([x, y], index) => <rect key={index} x={inset + x * step} y={inset + y * step}
      width={size} height={size} fill={index === 3 ? "var(--demo-accent)" : tile ? "white" : "currentColor"} />)}
  </svg>;
}
