using System.Diagnostics;
using Microsoft.Data.Sqlite;

namespace Haas.Hosty.TelemetryBackend;

// One metric sample ready to persist: the app it is attributed to, the series name + labels (the
// attribution label already stripped by the ingest layer), the value, and the scrape timestamp.
internal readonly record struct MetricSample(
    string AppId,
    string Name,
    IReadOnlyDictionary<string, string> Labels,
    double Value,
    long TimestampUnixMs);

// Estimated live payload of one signal table, used by the size-ceiling trim to decide which signal
// is responsible for the bloat. Row count × sampled average row bytes — coarse (indexes and page
// overhead excluded), which is fine: the trim selection compares tables against each other with a
// generous factor, it never needs absolute sizes.
internal readonly record struct TableSizeEstimate(string Table, long Rows, long AvgRowBytes)
{
    public long EstimatedBytes => Rows * AvgRowBytes;
}

// Embedded SQLite telemetry store (observability Phase 2). Persists metrics/logs/spans so a restart no
// longer drops the window (unlike Core's old in-memory stores), and answers the range/fleet queries the
// query API serves. One serialized connection guards all access — writes are small batch inserts each
// ingest tick and reads are occasional admin queries, so contention is negligible at homelab scale.
// Retention (per-signal age caps + a global size ceiling) keeps the file bounded, which is what lets an
// embedded SQLite stand in for a TSDB. See docs/features/observability-phase-2-backend.md.
internal sealed class SqliteTelemetryStore : IDisposable
{
    private readonly TelemetryBackendOptions options;
    private readonly SqliteConnection connection;
    private readonly object gate = new();

    public SqliteTelemetryStore(TelemetryBackendOptions options)
    {
        this.options = options;
        var directory = Path.GetDirectoryName(Path.GetFullPath(options.DatabasePath));
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }

        connection = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = options.DatabasePath,
            Mode = SqliteOpenMode.ReadWriteCreate,
        }.ToString());
        connection.Open();
        Initialize();
    }

    private void Initialize()
    {
        // WAL + NORMAL: concurrent-read-friendly and durable enough for live telemetry; incremental
        // auto_vacuum lets Prune reclaim space after age/size eviction without a full VACUUM.
        Execute("PRAGMA journal_mode=WAL;");
        Execute("PRAGMA synchronous=NORMAL;");
        Execute("PRAGMA busy_timeout=5000;");
        Execute("PRAGMA auto_vacuum=INCREMENTAL;");
        // auto_vacuum only takes effect on an empty database, so a db created by an earlier build with
        // auto_vacuum=NONE keeps it until a full VACUUM rewrites the file. Convert once on startup.
        if (QueryScalarLong("PRAGMA auto_vacuum;") != 2)
        {
            Execute("VACUUM;");
        }

        Execute("""
            CREATE TABLE IF NOT EXISTS metric_points (
                app_id      TEXT    NOT NULL,
                name        TEXT    NOT NULL,
                labels_json TEXT    NOT NULL,
                ts_ms       INTEGER NOT NULL,
                value       REAL    NOT NULL
            );
            CREATE INDEX IF NOT EXISTS ix_metric_points_app_ts ON metric_points(app_id, ts_ms);
            CREATE INDEX IF NOT EXISTS ix_metric_points_ts ON metric_points(ts_ms);

            CREATE TABLE IF NOT EXISTS log_records (
                app_id        TEXT    NOT NULL,
                ts_ms         INTEGER NOT NULL,
                severity      INTEGER NOT NULL,
                severity_text TEXT    NOT NULL,
                body          TEXT    NOT NULL,
                trace_id      TEXT,
                span_id       TEXT,
                attrs_json    TEXT    NOT NULL
            );
            CREATE INDEX IF NOT EXISTS ix_log_records_app_ts ON log_records(app_id, ts_ms);
            CREATE INDEX IF NOT EXISTS ix_log_records_ts ON log_records(ts_ms);

            CREATE TABLE IF NOT EXISTS spans (
                app_id         TEXT    NOT NULL,
                trace_id       TEXT    NOT NULL,
                span_id        TEXT    NOT NULL,
                parent_span_id TEXT,
                name           TEXT    NOT NULL,
                kind           TEXT    NOT NULL,
                start_nano     INTEGER NOT NULL,
                end_nano       INTEGER NOT NULL,
                status_code    TEXT    NOT NULL,
                status_message TEXT,
                attrs_json     TEXT    NOT NULL
            );
            CREATE INDEX IF NOT EXISTS ix_spans_trace ON spans(trace_id);
            CREATE INDEX IF NOT EXISTS ix_spans_app_start ON spans(app_id, start_nano);
            CREATE INDEX IF NOT EXISTS ix_spans_start ON spans(start_nano);

            CREATE TABLE IF NOT EXISTS ingest_state (
                name   TEXT    NOT NULL PRIMARY KEY,
                offset INTEGER NOT NULL
            );
            """);
    }

    // ---- Ingest (writes) ------------------------------------------------------------------------

    public void RecordMetrics(IReadOnlyList<MetricSample> samples)
    {
        if (samples.Count == 0)
        {
            return;
        }

        lock (gate)
        {
            using var tx = connection.BeginTransaction();
            using var cmd = connection.CreateCommand();
            cmd.Transaction = tx;
            cmd.CommandText =
                "INSERT INTO metric_points (app_id, name, labels_json, ts_ms, value) VALUES ($app, $name, $labels, $ts, $value);";
            var pApp = cmd.CreateParameter(); pApp.ParameterName = "$app"; cmd.Parameters.Add(pApp);
            var pName = cmd.CreateParameter(); pName.ParameterName = "$name"; cmd.Parameters.Add(pName);
            var pLabels = cmd.CreateParameter(); pLabels.ParameterName = "$labels"; cmd.Parameters.Add(pLabels);
            var pTs = cmd.CreateParameter(); pTs.ParameterName = "$ts"; cmd.Parameters.Add(pTs);
            var pValue = cmd.CreateParameter(); pValue.ParameterName = "$value"; cmd.Parameters.Add(pValue);

            foreach (var sample in samples)
            {
                // Drop non-finite values (NaN/±Inf), matching Core's in-memory store.
                if (string.IsNullOrWhiteSpace(sample.AppId) || !double.IsFinite(sample.Value) || sample.TimestampUnixMs <= 0)
                {
                    continue;
                }

                pApp.Value = sample.AppId;
                pName.Value = sample.Name;
                pLabels.Value = TelemetryJson.SerializeStringMap(sample.Labels);
                pTs.Value = sample.TimestampUnixMs;
                pValue.Value = sample.Value;
                cmd.ExecuteNonQuery();
            }

            tx.Commit();
        }
    }

    public void RecordLogs(IReadOnlyList<ParsedOtlpLog> logs)
    {
        if (logs.Count == 0)
        {
            return;
        }

        lock (gate)
        {
            using var tx = connection.BeginTransaction();
            using var cmd = connection.CreateCommand();
            cmd.Transaction = tx;
            cmd.CommandText =
                "INSERT INTO log_records (app_id, ts_ms, severity, severity_text, body, trace_id, span_id, attrs_json) " +
                "VALUES ($app, $ts, $sev, $sevt, $body, $trace, $span, $attrs);";
            var pApp = cmd.CreateParameter(); pApp.ParameterName = "$app"; cmd.Parameters.Add(pApp);
            var pTs = cmd.CreateParameter(); pTs.ParameterName = "$ts"; cmd.Parameters.Add(pTs);
            var pSev = cmd.CreateParameter(); pSev.ParameterName = "$sev"; cmd.Parameters.Add(pSev);
            var pSevt = cmd.CreateParameter(); pSevt.ParameterName = "$sevt"; cmd.Parameters.Add(pSevt);
            var pBody = cmd.CreateParameter(); pBody.ParameterName = "$body"; cmd.Parameters.Add(pBody);
            var pTrace = cmd.CreateParameter(); pTrace.ParameterName = "$trace"; cmd.Parameters.Add(pTrace);
            var pSpan = cmd.CreateParameter(); pSpan.ParameterName = "$span"; cmd.Parameters.Add(pSpan);
            var pAttrs = cmd.CreateParameter(); pAttrs.ParameterName = "$attrs"; cmd.Parameters.Add(pAttrs);

            foreach (var parsed in logs)
            {
                var record = parsed.Record;
                if (string.IsNullOrWhiteSpace(parsed.AppId) || record.TimestampUnixMs <= 0)
                {
                    continue;
                }

                pApp.Value = parsed.AppId;
                pTs.Value = record.TimestampUnixMs;
                pSev.Value = record.SeverityNumber;
                pSevt.Value = record.SeverityText;
                pBody.Value = record.Body;
                pTrace.Value = (object?)record.TraceId ?? DBNull.Value;
                pSpan.Value = (object?)record.SpanId ?? DBNull.Value;
                pAttrs.Value = TelemetryJson.SerializeStringMap(record.Attributes);
                cmd.ExecuteNonQuery();
            }

            tx.Commit();
        }
    }

    public void RecordSpans(IReadOnlyList<ParsedOtlpSpan> spans)
    {
        if (spans.Count == 0)
        {
            return;
        }

        lock (gate)
        {
            using var tx = connection.BeginTransaction();
            using var cmd = connection.CreateCommand();
            cmd.Transaction = tx;
            cmd.CommandText =
                "INSERT INTO spans (app_id, trace_id, span_id, parent_span_id, name, kind, start_nano, end_nano, status_code, status_message, attrs_json) " +
                "VALUES ($app, $trace, $span, $parent, $name, $kind, $start, $end, $code, $msg, $attrs);";
            var pApp = cmd.CreateParameter(); pApp.ParameterName = "$app"; cmd.Parameters.Add(pApp);
            var pTrace = cmd.CreateParameter(); pTrace.ParameterName = "$trace"; cmd.Parameters.Add(pTrace);
            var pSpan = cmd.CreateParameter(); pSpan.ParameterName = "$span"; cmd.Parameters.Add(pSpan);
            var pParent = cmd.CreateParameter(); pParent.ParameterName = "$parent"; cmd.Parameters.Add(pParent);
            var pName = cmd.CreateParameter(); pName.ParameterName = "$name"; cmd.Parameters.Add(pName);
            var pKind = cmd.CreateParameter(); pKind.ParameterName = "$kind"; cmd.Parameters.Add(pKind);
            var pStart = cmd.CreateParameter(); pStart.ParameterName = "$start"; cmd.Parameters.Add(pStart);
            var pEnd = cmd.CreateParameter(); pEnd.ParameterName = "$end"; cmd.Parameters.Add(pEnd);
            var pCode = cmd.CreateParameter(); pCode.ParameterName = "$code"; cmd.Parameters.Add(pCode);
            var pMsg = cmd.CreateParameter(); pMsg.ParameterName = "$msg"; cmd.Parameters.Add(pMsg);
            var pAttrs = cmd.CreateParameter(); pAttrs.ParameterName = "$attrs"; cmd.Parameters.Add(pAttrs);

            foreach (var parsed in spans)
            {
                var span = parsed.Span;
                if (string.IsNullOrWhiteSpace(parsed.AppId) || span.StartUnixNano <= 0 ||
                    string.IsNullOrWhiteSpace(span.TraceId) || string.IsNullOrWhiteSpace(span.SpanId))
                {
                    continue;
                }

                pApp.Value = parsed.AppId;
                // Normalize the trace id to lowercase on write so trace-detail lookups can use the
                // default (binary) index with an ordinal `=` instead of a full-scan COLLATE NOCASE.
                pTrace.Value = span.TraceId.ToLowerInvariant();
                pSpan.Value = span.SpanId;
                pParent.Value = (object?)span.ParentSpanId ?? DBNull.Value;
                pName.Value = span.Name;
                pKind.Value = span.Kind;
                pStart.Value = span.StartUnixNano;
                pEnd.Value = span.EndUnixNano;
                pCode.Value = span.StatusCode;
                pMsg.Value = (object?)span.StatusMessage ?? DBNull.Value;
                pAttrs.Value = TelemetryJson.SerializeStringMap(span.Attributes);
                cmd.ExecuteNonQuery();
            }

            tx.Commit();
        }
    }

    // ---- Queries (reads) ------------------------------------------------------------------------

    // All series for an app holding at least one point at or after `since`, each trimmed to that window
    // and grouped by (name, canonical-labels). Mirrors Core's IMetricStore.Query.
    public IReadOnlyList<MetricSeriesSnapshot> QueryMetrics(string appId, long sinceMs)
    {
        if (string.IsNullOrWhiteSpace(appId))
        {
            return [];
        }

        lock (gate)
        {
            using var cmd = connection.CreateCommand();
            cmd.CommandText =
                "SELECT name, labels_json, ts_ms, value FROM metric_points WHERE app_id = $app AND ts_ms >= $since " +
                "ORDER BY name, labels_json, ts_ms;";
            AddParam(cmd, "$app", appId);
            AddParam(cmd, "$since", sinceMs);

            var series = new List<MetricSeriesSnapshot>();
            string? currentName = null;
            string? currentLabels = null;
            List<MetricPoint>? points = null;

            using var reader = cmd.ExecuteReader();
            while (reader.Read())
            {
                var name = reader.GetString(0);
                var labels = reader.GetString(1);
                if (!string.Equals(name, currentName, StringComparison.Ordinal) ||
                    !string.Equals(labels, currentLabels, StringComparison.Ordinal))
                {
                    FlushSeries(series, currentName, currentLabels, points);
                    currentName = name;
                    currentLabels = labels;
                    points = [];
                }

                points!.Add(new MetricPoint(reader.GetInt64(2), reader.GetDouble(3)));
            }

            FlushSeries(series, currentName, currentLabels, points);
            return series;
        }
    }

    private static void FlushSeries(List<MetricSeriesSnapshot> series, string? name, string? labels, List<MetricPoint>? points)
    {
        if (name is null || points is null || points.Count == 0)
        {
            return;
        }

        series.Add(new MetricSeriesSnapshot(name, TelemetryJson.DeserializeStringMap(labels), points));
    }

    // The app's OTLP log records at or after `since`, optionally filtered to severity >= minSeverity,
    // in chronological order (newest last), capped to the most recent `limit`. Mirrors ILogStore.Query.
    public IReadOnlyList<OtlpLogRecord> QueryOtlpLogs(string appId, long sinceMs, int? minSeverity, int limit)
    {
        if (string.IsNullOrWhiteSpace(appId) || limit <= 0)
        {
            return [];
        }

        lock (gate)
        {
            using var cmd = connection.CreateCommand();
            cmd.CommandText =
                "SELECT ts_ms, severity, severity_text, body, trace_id, span_id, attrs_json FROM log_records " +
                "WHERE app_id = $app AND ts_ms >= $since AND ($minSev IS NULL OR severity >= $minSev) " +
                "ORDER BY ts_ms DESC LIMIT $limit;";
            AddParam(cmd, "$app", appId);
            AddParam(cmd, "$since", sinceMs);
            AddParam(cmd, "$minSev", minSeverity.HasValue ? minSeverity.Value : DBNull.Value);
            AddParam(cmd, "$limit", limit);

            var records = new List<OtlpLogRecord>();
            using var reader = cmd.ExecuteReader();
            while (reader.Read())
            {
                records.Add(ReadLog(reader));
            }

            records.Reverse(); // DESC-limited newest set → chronological (newest last)
            return records;
        }
    }

    // Cross-app OTLP log records at or after `since`, optionally severity/app/body filtered, in
    // chronological order (newest last), capped globally to `limit`. Equivalent to Core's per-app
    // merge: the newest `limit` across apps are the same set. Records are attributed (AppId carried).
    public IReadOnlyList<ParsedOtlpLog> QueryFleetLogs(
        long sinceMs, int? minSeverity, int limit, IReadOnlyCollection<string>? appFilter, string? query)
    {
        if (limit <= 0)
        {
            return [];
        }

        lock (gate)
        {
            using var cmd = connection.CreateCommand();
            var sql =
                "SELECT app_id, ts_ms, severity, severity_text, body, trace_id, span_id, attrs_json FROM log_records " +
                "WHERE ts_ms >= $since AND ($minSev IS NULL OR severity >= $minSev) " +
                "AND ($q IS NULL OR instr(lower(body), lower($q)) > 0)";
            sql += BuildAppFilter(cmd, appFilter);
            sql += " ORDER BY ts_ms DESC LIMIT $limit;";
            cmd.CommandText = sql;
            AddParam(cmd, "$since", sinceMs);
            AddParam(cmd, "$minSev", minSeverity.HasValue ? minSeverity.Value : DBNull.Value);
            AddParam(cmd, "$q", string.IsNullOrWhiteSpace(query) ? DBNull.Value : query.Trim());
            AddParam(cmd, "$limit", limit);

            var records = new List<ParsedOtlpLog>();
            using var reader = cmd.ExecuteReader();
            while (reader.Read())
            {
                var appId = reader.GetString(0);
                records.Add(new ParsedOtlpLog(appId, ReadLog(reader, offset: 1)));
            }

            records.Reverse();
            return records;
        }
    }

    // In-window spans (start >= sinceNano), optionally app-filtered, newest-start first, capped to
    // `scanCap`. The query service groups these by trace id into fleet summaries (like Core's per-app
    // Query feeding TraceAccumulator). Spans are attributed (AppId carried).
    public IReadOnlyList<ParsedOtlpSpan> QueryInWindowSpans(long sinceNano, IReadOnlyCollection<string>? appFilter, int scanCap)
    {
        if (scanCap <= 0)
        {
            return [];
        }

        lock (gate)
        {
            using var cmd = connection.CreateCommand();
            var sql = "SELECT app_id, trace_id, span_id, parent_span_id, name, kind, start_nano, end_nano, status_code, status_message, attrs_json " +
                      "FROM spans WHERE start_nano >= $since";
            sql += BuildAppFilter(cmd, appFilter);
            sql += " ORDER BY start_nano DESC LIMIT $limit;";
            cmd.CommandText = sql;
            AddParam(cmd, "$since", sinceNano);
            AddParam(cmd, "$limit", scanCap);

            return ReadSpans(cmd);
        }
    }

    // Every stored span of one trace across all apps (case-insensitive id match), for the trace-detail
    // read path. Mirrors ITraceStore.QueryTrace merged across apps.
    public IReadOnlyList<ParsedOtlpSpan> QueryTraceSpans(string traceId)
    {
        if (string.IsNullOrWhiteSpace(traceId))
        {
            return [];
        }

        lock (gate)
        {
            using var cmd = connection.CreateCommand();
            cmd.CommandText =
                "SELECT app_id, trace_id, span_id, parent_span_id, name, kind, start_nano, end_nano, status_code, status_message, attrs_json " +
                "FROM spans WHERE trace_id = $trace;";
            // Trace ids are stored lowercase, so match on the lowercased input via the binary index.
            AddParam(cmd, "$trace", traceId.Trim().ToLowerInvariant());
            return ReadSpans(cmd);
        }
    }

    private static IReadOnlyList<ParsedOtlpSpan> ReadSpans(SqliteCommand cmd)
    {
        var spans = new List<ParsedOtlpSpan>();
        using var reader = cmd.ExecuteReader();
        while (reader.Read())
        {
            spans.Add(new ParsedOtlpSpan(reader.GetString(0), new OtlpSpan(
                TraceId: reader.GetString(1),
                SpanId: reader.GetString(2),
                ParentSpanId: reader.IsDBNull(3) ? null : reader.GetString(3),
                Name: reader.GetString(4),
                Kind: reader.GetString(5),
                StartUnixNano: reader.GetInt64(6),
                EndUnixNano: reader.GetInt64(7),
                StatusCode: reader.GetString(8),
                StatusMessage: reader.IsDBNull(9) ? null : reader.GetString(9),
                Attributes: TelemetryJson.DeserializeStringMap(reader.GetString(10)))));
        }

        return spans;
    }

    private static OtlpLogRecord ReadLog(SqliteDataReader reader, int offset = 0)
        => new(
            TimestampUnixMs: reader.GetInt64(offset + 0),
            SeverityNumber: reader.GetInt32(offset + 1),
            SeverityText: reader.GetString(offset + 2),
            Body: reader.GetString(offset + 3),
            Attributes: TelemetryJson.DeserializeStringMap(reader.GetString(offset + 6)),
            TraceId: reader.IsDBNull(offset + 4) ? null : reader.GetString(offset + 4),
            SpanId: reader.IsDBNull(offset + 5) ? null : reader.GetString(offset + 5));

    // ---- Retention ------------------------------------------------------------------------------

    // The three signal tables, with the column age eviction / oldest-first trims order by and the TEXT
    // columns that dominate each row's payload (for the ceiling's per-table size estimation).
    private sealed record SignalTable(string Table, string OrderColumn, string PayloadSizeExpr);

    private static readonly SignalTable MetricPointsTable = new("metric_points", "ts_ms",
        "length(app_id) + length(name) + length(labels_json)");
    private static readonly SignalTable LogRecordsTable = new("log_records", "ts_ms",
        "length(app_id) + length(severity_text) + length(body) + coalesce(length(trace_id), 0) + coalesce(length(span_id), 0) + length(attrs_json)");
    private static readonly SignalTable SpansTable = new("spans", "start_nano",
        "length(app_id) + length(trace_id) + length(span_id) + coalesce(length(parent_span_id), 0) + length(name) + length(kind) + length(status_code) + coalesce(length(status_message), 0) + length(attrs_json)");

    private static readonly SignalTable[] SignalTables = [MetricPointsTable, LogRecordsTable, SpansTable];

    // Rows deleted per chunk: small enough that one chunk is milliseconds of work (the budget check in
    // PruneStep runs between chunks, so a chunk is also the worst-case budget overshoot).
    private const int PruneChunkRows = 5000;
    // Newest rows sampled per table when estimating average row bytes.
    private const int SizeSampleRows = 1000;
    // Fixed per-row bytes on top of the sampled TEXT payload (record header, rowid, integer columns).
    private const int RowOverheadBytes = 48;
    // Freelist pages reclaimed per incremental_vacuum chunk (~4 MiB at the default 4 KiB page size).
    private const int VacuumChunkPages = 1000;

    // Runs prune passes to completion. Tests and small stores use this; the production ingest loop
    // calls PruneStep directly so one pass never monopolizes the store.
    public void Prune(DateTimeOffset now)
    {
        while (!PruneStep(now, TimeSpan.FromSeconds(1)))
        {
        }
    }

    // One bounded slice of a prune pass: age eviction, size-ceiling trims, freed-page reclaim, WAL
    // checkpoint — in that order, chunked, stopping once `budget` elapses. Returns true when the pass
    // completed, false when work remains (call again to resume; every call makes at least one chunk of
    // progress, so a pass always terminates). Bounding the slice is what keeps log/trace tailing
    // responsive: the old all-at-once Prune held the store for minutes on a ceiling-pinned ~1 GiB
    // database, and ingest stalled for exactly that long.
    public bool PruneStep(DateTimeOffset now, TimeSpan budget)
    {
        lock (gate)
        {
            var clock = Stopwatch.StartNew();
            var nowMs = now.ToUnixTimeMilliseconds();

            // Age eviction, oldest first in bounded chunks. A short chunk (< PruneChunkRows deleted)
            // means the table is caught up; a full chunk means more may remain, so check the budget.
            (SignalTable Signal, long Cutoff)[] ageCutoffs =
            [
                (MetricPointsTable, nowMs - (long)options.MetricsRetention.TotalMilliseconds),
                (LogRecordsTable, nowMs - (long)options.LogsRetention.TotalMilliseconds),
                (SpansTable, (nowMs - (long)options.TracesRetention.TotalMilliseconds) * 1_000_000L),
            ];
            foreach (var (signal, cutoff) in ageCutoffs)
            {
                while (DeleteOldest(signal, cutoff, PruneChunkRows) == PruneChunkRows)
                {
                    if (clock.Elapsed >= budget)
                    {
                        return false;
                    }
                }
            }

            // Hard safety cap: while the database exceeds the ceiling, trim the oldest chunk from the
            // signal(s) actually responsible for the bloat — not from every table, which let a metrics
            // flood evict the last few days of scarce log rows down to a minutes-wide window. Sizes are
            // estimated once per call and decremented as trims land (the lock makes them consistent).
            List<TableSizeEstimate>? estimates = null;
            while (DatabaseBytes() > options.MaxDatabaseBytes)
            {
                estimates ??= SignalTables.Select(EstimateTableSize).ToList();
                var targets = SelectTrimTargets(estimates);
                if (targets.Count == 0)
                {
                    break; // every table is empty; the residue is file overhead the vacuum handles
                }

                var trimmedAny = false;
                foreach (var target in targets)
                {
                    var signal = Array.Find(SignalTables, s => s.Table == target.Table)!;
                    var trimmed = DeleteOldest(signal, cutoff: null, PruneChunkRows);
                    trimmedAny |= trimmed > 0;
                    var index = estimates.FindIndex(e => e.Table == target.Table);
                    estimates[index] = estimates[index] with { Rows = Math.Max(0, estimates[index].Rows - trimmed) };
                }

                if (!trimmedAny)
                {
                    break; // estimates disagree with the tables; never spin inside the lock
                }

                if (clock.Elapsed >= budget)
                {
                    return false;
                }
            }

            // Reclaim freed pages in bounded chunks (a full incremental_vacuum after a big eviction is
            // one of the slow statements the old inline Prune stalled on).
            var freelist = QueryScalarLong("PRAGMA freelist_count;");
            while (freelist > 0)
            {
                Execute($"PRAGMA incremental_vacuum({VacuumChunkPages});");
                var remaining = QueryScalarLong("PRAGMA freelist_count;");
                if (remaining >= freelist)
                {
                    break; // cannot shrink further
                }

                freelist = remaining;
                if (clock.Elapsed >= budget)
                {
                    return false;
                }
            }

            // Fold the WAL back into the main db and truncate it, so on-disk usage (db + wal) stays
            // near the logical size the ceiling measures rather than growing unbounded under writes.
            // Auto-checkpointing keeps the WAL modest between passes, so this stays cheap.
            Execute("PRAGMA wal_checkpoint(TRUNCATE);");
            return true;
        }
    }

    // The tables the ceiling should trim this iteration: every table whose estimated bytes are within
    // ComparableSizeFactor of the largest. A flooded signal dominates and is trimmed alone, sparing the
    // scarce ones; when sizes are comparable no signal is at fault, so all of them share the trim.
    internal const int ComparableSizeFactor = 4;

    internal static IReadOnlyList<TableSizeEstimate> SelectTrimTargets(IReadOnlyList<TableSizeEstimate> estimates)
    {
        var largest = 0L;
        foreach (var estimate in estimates)
        {
            largest = Math.Max(largest, estimate.EstimatedBytes);
        }

        if (largest == 0)
        {
            return [];
        }

        return estimates
            .Where(e => e.EstimatedBytes > 0 && e.EstimatedBytes * ComparableSizeFactor >= largest)
            .ToList();
    }

    private TableSizeEstimate EstimateTableSize(SignalTable signal)
    {
        var rows = QueryScalarLong($"SELECT COUNT(*) FROM {signal.Table};");
        if (rows == 0)
        {
            return new TableSizeEstimate(signal.Table, 0, 0);
        }

        // Average payload over the most recently *inserted* rows — descending rowid, which is insertion
        // order, not timestamp order (a late-arriving out-of-order record still samples as recent).
        // That is deliberate: rowid needs no index sort, and row width is what's being estimated, which
        // barely correlates with event time. dbstat would give exact per-table pages but isn't
        // guaranteed in the bundled SQLite, and the trim selection only compares tables to each other.
        var avgPayload = QueryScalarLong(
            $"SELECT CAST(coalesce(avg({signal.PayloadSizeExpr}), 0) AS INTEGER) " +
            $"FROM (SELECT * FROM {signal.Table} ORDER BY rowid DESC LIMIT {SizeSampleRows});");
        return new TableSizeEstimate(signal.Table, rows, avgPayload + RowOverheadBytes);
    }

    // Deletes up to `limit` oldest rows — only those older than `cutoff` when given (age eviction),
    // unconditionally when null (ceiling trim). Returns the number of rows deleted.
    private int DeleteOldest(SignalTable signal, long? cutoff, int limit)
    {
        using var cmd = connection.CreateCommand();
        cmd.CommandText = cutoff is null
            ? $"DELETE FROM {signal.Table} WHERE rowid IN (SELECT rowid FROM {signal.Table} ORDER BY {signal.OrderColumn} ASC LIMIT $limit);"
            : $"DELETE FROM {signal.Table} WHERE rowid IN (SELECT rowid FROM {signal.Table} WHERE {signal.OrderColumn} < $cutoff ORDER BY {signal.OrderColumn} ASC LIMIT $limit);";
        if (cutoff is { } value)
        {
            AddParam(cmd, "$cutoff", value);
        }

        AddParam(cmd, "$limit", limit);
        return cmd.ExecuteNonQuery();
    }

    // Logical active size = (allocated − freelist) pages × page size. Excluding freelist pages is
    // essential for the size-ceiling trim loop in PruneStep: DELETE moves pages to the freelist without
    // shrinking page_count (that waits for the vacuum), so a raw page_count would not fall between loop
    // iterations and the loop would over-delete. The freed pages are reclaimed by the chunked
    // incremental_vacuum that follows the trim loop.
    private long DatabaseBytes()
    {
        var pageCount = QueryScalarLong("PRAGMA page_count;");
        var freelistCount = QueryScalarLong("PRAGMA freelist_count;");
        var pageSize = QueryScalarLong("PRAGMA page_size;");
        return Math.Max(0, pageCount - freelistCount) * pageSize;
    }

    private long QueryScalarLong(string sql)
    {
        using var cmd = connection.CreateCommand();
        cmd.CommandText = sql;
        return Convert.ToInt64(cmd.ExecuteScalar() ?? 0L);
    }

    // ---- Ingest tail state (persisted so a restart resumes instead of replaying the whole file) ----

    public long GetTailOffset(string name)
    {
        lock (gate)
        {
            using var cmd = connection.CreateCommand();
            cmd.CommandText = "SELECT offset FROM ingest_state WHERE name = $name;";
            AddParam(cmd, "$name", name);
            var value = cmd.ExecuteScalar();
            return value is null or DBNull ? 0 : Convert.ToInt64(value);
        }
    }

    public void SaveTailOffset(string name, long offset)
    {
        lock (gate)
        {
            using var cmd = connection.CreateCommand();
            cmd.CommandText =
                "INSERT INTO ingest_state (name, offset) VALUES ($name, $offset) " +
                "ON CONFLICT(name) DO UPDATE SET offset = excluded.offset;";
            AddParam(cmd, "$name", name);
            AddParam(cmd, "$offset", offset);
            cmd.ExecuteNonQuery();
        }
    }

    // ---- Helpers --------------------------------------------------------------------------------

    // Appends ` AND app_id IN ($a0,$a1,…)` and binds the parameters, or nothing when no filter.
    private static string BuildAppFilter(SqliteCommand cmd, IReadOnlyCollection<string>? appFilter)
    {
        if (appFilter is not { Count: > 0 })
        {
            return string.Empty;
        }

        var names = new List<string>(appFilter.Count);
        var index = 0;
        foreach (var appId in appFilter)
        {
            var name = $"$a{index++}";
            names.Add(name);
            AddParam(cmd, name, appId);
        }

        return $" AND app_id IN ({string.Join(",", names)})";
    }

    private static void AddParam(SqliteCommand cmd, string name, object value)
    {
        var parameter = cmd.CreateParameter();
        parameter.ParameterName = name;
        parameter.Value = value ?? DBNull.Value;
        cmd.Parameters.Add(parameter);
    }

    private void Execute(string sql)
    {
        using var cmd = connection.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }

    public void Dispose() => connection.Dispose();
}
