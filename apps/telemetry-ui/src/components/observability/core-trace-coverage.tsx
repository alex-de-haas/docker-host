import type { CoreTraceCoverage } from "@/lib/types";

export function CoreTraceCoverageNote({ coverage }: { coverage?: CoreTraceCoverage | null }) {
  if (!coverage) return <p className="text-xs text-muted-foreground">Core trace coverage is not available from this backend.</p>;
  const active = coverage.capturing && coverage.state === "receiving";
  return <div className="space-y-1 rounded-lg border bg-muted/20 px-3 py-2 text-xs text-muted-foreground" role="status">
    <p><span className="font-medium text-foreground">Latest Core report: {active ? "capturing" : coverage.state === "unsupported" ? "not supported by this Core" : "capture unavailable"}.</span>
      {" "}Root sampling {Math.round(coverage.rootSampleRatio * 100)}%; parent sampling is respected. Trace counts do not measure total API traffic.</p>
    <p>{coverage.runId ? `Report received ${new Date(coverage.observedAt).toLocaleString()}.` : "No Core capture report has been received yet."}</p>
    {coverage.captureStartedAt && <p>Capture started {new Date(coverage.captureStartedAt).toLocaleString()}. Earlier requests have no retroactive trace.</p>}
    {coverage.gapCount > 0 && <p>Coverage gaps: {coverage.gapCount}. Latest: {coverage.lastGapReason?.replaceAll("_", " ")}{coverage.lastGapAt ? ` at ${new Date(coverage.lastGapAt).toLocaleString()}` : ""}.</p>}
    {(coverage.droppedSpans > 0 || coverage.truncatedSpans > 0) && <p>Core buffer evictions or drops: {coverage.droppedSpans}; oversized spans: {coverage.truncatedSpans}. Retention is bounded.</p>}
  </div>;
}
