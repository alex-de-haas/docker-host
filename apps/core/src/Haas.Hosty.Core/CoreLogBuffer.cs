namespace Haas.Hosty.Core;

// Core's own log records, held in memory so the host can be looked at from the UI it already serves.
//
// Why not `core.log`: that file exists only because the CLI redirects Core's stdout into it on a
// background start. A foreground or `npm run dev` Core has no file at all, the next background start
// truncates it, and nothing rotates it. It stays the post-mortem artifact for a Core that is *not*
// running; this is the live view for one that is.
//
// Two rings, not one. Measured over 26.6 h of a real host: ~96 % of records are the ASP.NET request
// pipeline and only ~0.06 % are Core's own, so a shared ring would let request chatter evict the
// events worth reading inside an hour. Splitting by category keeps Core's own history measured in
// weeks while the request trail stays available at its own (much shorter) depth.
//
// See docs/features/observability/plan.md.
internal sealed class CoreLogBuffer
{
    // Core's own categories plus anything third-party it hosts (the MCP server, ~2 records/hour).
    // `Microsoft.*` and `System.*` are the framework: the request pipeline, CORS, and the outbound
    // HttpClient handlers, none of which describe what Core decided to do.
    public const int DefaultHostyCapacity = 2000;
    public const int DefaultFrameworkCapacity = 2000;

    // The id Core's own records are attributed to once they reach the telemetry store. Reserved, and
    // deliberately never added to the app-directory roster: every appId-keyed layer treats it as an
    // opaque key, but the roster is also what the ai-gateway reads to discover providers.
    public const string CoreSourceId = "hosty.core";

    private readonly CoreLogRing hosty;
    private readonly CoreLogRing framework;

    public CoreLogBuffer(int hostyCapacity = DefaultHostyCapacity, int frameworkCapacity = DefaultFrameworkCapacity)
    {
        hosty = new CoreLogRing(hostyCapacity);
        framework = new CoreLogRing(frameworkCapacity);
    }

    // Identifies this process run. The rings die with the process, so a consumer holding a cursor must
    // be able to tell "nothing new since sequence N" from "a different Core is answering now"; the
    // backend's pull loop resets its cursor when this changes, the same way its file tails reset on
    // rotation.
    public string RunId { get; } = Guid.NewGuid().ToString("n");

    public static bool IsFrameworkCategory(string category)
        => category.StartsWith("Microsoft.", StringComparison.Ordinal)
            || category.StartsWith("System.", StringComparison.Ordinal)
            || string.Equals(category, "Microsoft", StringComparison.Ordinal)
            || string.Equals(category, "System", StringComparison.Ordinal);

    public CoreLogRing Ring(CoreLogRingKind kind) => kind == CoreLogRingKind.Framework ? framework : hosty;

    public void Add(DateTimeOffset timestamp, LogLevel level, string category, string message, string? exception)
        => Ring(IsFrameworkCategory(category) ? CoreLogRingKind.Framework : CoreLogRingKind.Hosty)
            .Add(timestamp, level, category, message, exception);
}

internal enum CoreLogRingKind
{
    Hosty,
    Framework,
}

// Fixed-capacity ring with collapse-on-repeat. Sequences are per-ring and monotonic: only the export
// reads them, and it only ever reads one ring.
internal sealed class CoreLogRing(int capacity)
{
    private readonly object gate = new();
    private readonly Entry[] slots = new Entry[capacity];
    private int count;
    private int start;
    private long nextSequence;

    public int Capacity => capacity;

    // A record identical to the newest one folds into it — count and last-seen advance, the sequence
    // and timestamp stay at the first occurrence. This is the `DockerStatsExposition` case: its tick
    // warns every 10 s while docker is unavailable, which is 360 slots an hour, during an outage that
    // has also taken the telemetry containers down so nothing is draining the ring. Folding costs the
    // export nothing it would have used: it already saw the record, and the growing count is a reading
    // aid rather than a new event. Deliberately only against the newest entry — "last message repeated
    // N times" semantics, which is what a repeating tick actually produces.
    public void Add(DateTimeOffset timestamp, LogLevel level, string category, string message, string? exception)
    {
        lock (gate)
        {
            if (count > 0)
            {
                var newest = slots[(start + count - 1) % capacity];
                if (newest.Level == level
                    && string.Equals(newest.Category, category, StringComparison.Ordinal)
                    && string.Equals(newest.Message, message, StringComparison.Ordinal)
                    && string.Equals(newest.Exception, exception, StringComparison.Ordinal))
                {
                    newest.Count++;
                    newest.LastSeen = timestamp;
                    return;
                }
            }

            var entry = new Entry
            {
                Sequence = ++nextSequence,
                Timestamp = timestamp,
                Level = level,
                Category = category,
                Message = message,
                Exception = exception,
                Count = 1,
                LastSeen = timestamp,
            };

            if (count == capacity)
            {
                slots[start] = entry;
                start = (start + 1) % capacity;
                return;
            }

            slots[(start + count) % capacity] = entry;
            count++;
        }
    }

    // Newest `tail` records at or above `minLevel`, oldest first — the order a log view reads in.
    public IReadOnlyList<CoreLogRecord> Read(int tail, LogLevel minLevel)
    {
        if (tail <= 0)
        {
            return [];
        }

        lock (gate)
        {
            var matched = new List<CoreLogRecord>(Math.Min(tail, count));
            for (var offset = count - 1; offset >= 0 && matched.Count < tail; offset--)
            {
                var entry = slots[(start + offset) % capacity];
                if (entry.Level >= minLevel)
                {
                    matched.Add(entry.ToRecord());
                }
            }

            matched.Reverse();
            return matched;
        }
    }

    // Everything newer than `afterSequence`, oldest first — the cursor read the telemetry backend
    // pulls. A cursor pointing at a record the ring has already evicted simply resumes at the oldest
    // record still held; the gap is real and deliberate (see the plan's durability decision).
    public IReadOnlyList<CoreLogRecord> ReadAfter(long afterSequence, int limit, LogLevel minLevel)
    {
        if (limit <= 0)
        {
            return [];
        }

        lock (gate)
        {
            var matched = new List<CoreLogRecord>();
            for (var offset = 0; offset < count && matched.Count < limit; offset++)
            {
                var entry = slots[(start + offset) % capacity];
                if (entry.Sequence > afterSequence && entry.Level >= minLevel)
                {
                    matched.Add(entry.ToRecord());
                }
            }

            return matched;
        }
    }

    // Mutable under the ring's lock so a repeat folds in place; projected to the immutable wire record
    // on read.
    private sealed class Entry
    {
        public long Sequence;
        public DateTimeOffset Timestamp;
        public LogLevel Level;
        public string Category = string.Empty;
        public string Message = string.Empty;
        public string? Exception;
        public int Count;
        public DateTimeOffset LastSeen;

        public CoreLogRecord ToRecord() => new(
            Sequence,
            Timestamp,
            Level.ToString(),
            Category,
            Message,
            Exception,
            Count,
            LastSeen);
    }
}

// One buffered record, as the API returns it. `count` and `lastSeen` describe a run of identical
// repeats folded into this record; a record that happened once carries count 1 and lastSeen equal to
// its timestamp.
internal sealed record CoreLogRecord(
    long Sequence,
    DateTimeOffset Timestamp,
    string Level,
    string Category,
    string Message,
    string? Exception,
    int Count,
    DateTimeOffset LastSeen);
