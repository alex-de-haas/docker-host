using System.Text.Json;

namespace Haas.Hosty.TelemetryBackend;

internal sealed partial class SqliteTelemetryStore
{
    private void InitializeCoreTraces()
    {
        if (QueryScalarLong("SELECT count(*) FROM pragma_table_info('spans') WHERE name = 'core_run_id';") == 0)
            Execute("ALTER TABLE spans ADD COLUMN core_run_id TEXT;");
        Execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS ix_core_span_identity ON spans(app_id, core_run_id, trace_id, span_id) WHERE core_run_id IS NOT NULL;
            CREATE INDEX IF NOT EXISTS ix_log_records_trace ON log_records(trace_id, ts_ms);
            CREATE INDEX IF NOT EXISTS ix_core_spans_caller ON spans(json_extract(attrs_json, '$."hosty.caller.app.id"'), start_nano) WHERE app_id = 'hosty.core' AND core_run_id IS NOT NULL;
            CREATE TABLE IF NOT EXISTS core_trace_ingest (id INTEGER PRIMARY KEY CHECK (id = 1), run_id TEXT NOT NULL, cursor INTEGER NOT NULL, coverage_json TEXT NOT NULL);
            """);
    }
    public CoreTraceCheckpoint? GetCoreTraceCheckpoint()
    {
        lock (gate)
        {
            using var cmd = connection.CreateCommand();
            cmd.CommandText = "SELECT run_id, cursor, coverage_json FROM core_trace_ingest WHERE id = 1;";
            using var reader = cmd.ExecuteReader();
            if (!reader.Read()) return null;
            var coverage = JsonSerializer.Deserialize(reader.GetString(2), CoreTraceJsonContext.Default.CoreTraceCoverage);
            return coverage is null ? null : new(reader.GetString(0), reader.GetInt64(1), coverage);
        }
    }
    // Spans, coverage and cursor commit together. Replayed pages cannot create duplicate spans.
    public void RecordCoreTracePage(ParsedCoreTracePull page)
    {
        lock (gate)
        {
            var previous = GetCoreTraceCheckpoint();
            var replayed = previous?.RunId == page.RunId && page.NextCursor <= previous.Cursor;
            var gap = (replayed ? null : page.GapReason) ?? (previous is not null && previous.RunId != page.RunId ? "core_restarted" : null)
                ?? (previous?.Coverage.CaptureStartedAt is { } started && page.Coverage.CaptureStartedAt > started ? "capture_resumed" : null);
            var coverage = page.Coverage with { LastGapReason = gap ?? previous?.Coverage.LastGapReason,
                LastGapAt = gap is not null ? page.Coverage.ObservedAt : previous?.Coverage.LastGapAt,
                GapCount = (previous?.Coverage.GapCount ?? 0) + (gap is not null ? 1 : 0) };
            using var tx = connection.BeginTransaction();
            using var cmd = connection.CreateCommand(); cmd.Transaction = tx;
            cmd.CommandText = """
                INSERT OR IGNORE INTO spans (app_id, core_run_id, trace_id, span_id, parent_span_id, name, kind, start_nano, end_nano, status_code, status_message, attrs_json)
                VALUES ('hosty.core', $run, $trace, $span, $parent, $name, $kind, $start, $end, $code, NULL, $attrs);
                """;
            foreach (var parsed in page.Spans)
            {
                var span = parsed.Span;
                cmd.Parameters.Clear();
                AddParam(cmd, "$run", page.RunId); AddParam(cmd, "$trace", span.TraceId); AddParam(cmd, "$span", span.SpanId);
                AddParam(cmd, "$parent", (object?)span.ParentSpanId ?? DBNull.Value); AddParam(cmd, "$name", span.Name); AddParam(cmd, "$kind", span.Kind);
                AddParam(cmd, "$start", span.StartUnixNano); AddParam(cmd, "$end", span.EndUnixNano); AddParam(cmd, "$code", span.StatusCode);
                AddParam(cmd, "$attrs", TelemetryJson.SerializeStringMap(span.Attributes)); cmd.ExecuteNonQuery();
            }
            cmd.Parameters.Clear();
            cmd.CommandText = "INSERT INTO core_trace_ingest (id, run_id, cursor, coverage_json) VALUES (1, $run, $cursor, $coverage) ON CONFLICT(id) DO UPDATE SET run_id=$run, cursor=$cursor, coverage_json=$coverage;";
            AddParam(cmd, "$run", page.RunId); AddParam(cmd, "$cursor", previous?.RunId == page.RunId ? Math.Max(page.NextCursor, previous.Cursor) : page.NextCursor);
            AddParam(cmd, "$coverage", JsonSerializer.Serialize(coverage, CoreTraceJsonContext.Default.CoreTraceCoverage));
            cmd.ExecuteNonQuery(); tx.Commit();
        }
    }
    public void RecordCoreTraceFailure(string state)
    {
        lock (gate)
        {
            var previous = GetCoreTraceCheckpoint();
            var coverage = previous?.Coverage ?? new(1, "", false, null, 0, DateTimeOffset.MinValue, 0, 0, 0, 0);
            using var cmd = connection.CreateCommand();
            cmd.CommandText = "INSERT INTO core_trace_ingest (id, run_id, cursor, coverage_json) VALUES (1, $run, $cursor, $coverage) ON CONFLICT(id) DO UPDATE SET coverage_json=$coverage;";
            AddParam(cmd, "$run", previous?.RunId ?? ""); AddParam(cmd, "$cursor", previous?.Cursor ?? 0);
            AddParam(cmd, "$coverage", JsonSerializer.Serialize(coverage with { State = state, Capturing = false }, CoreTraceJsonContext.Default.CoreTraceCoverage));
            cmd.ExecuteNonQuery();
        }
    }
}
