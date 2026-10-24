/** Telemetry's app-owned cell mark, matching its manifest icon without a platform ID lookup. */
export function TelemetryMark({ className, tile = false }: { className?: string; tile?: boolean }) {
  const size = tile ? 16 : 22;
  const step = tile ? 21.5 : 29;
  const inset = tile ? 20.5 : 10;
  const cells = [[0, 0], [1, 0], [2, 0], [1, 1], [1, 2]];

  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      {tile && <rect className="telemetry-mark-tile" width="100" height="100" rx="22" />}
      {cells.map(([x, y], index) => (
        <rect key={index} x={inset + x * step} y={inset + y * step} width={size} height={size}
          fill={index === 1 ? "var(--telemetry-accent)" : tile ? "white" : "currentColor"} />
      ))}
    </svg>
  );
}
