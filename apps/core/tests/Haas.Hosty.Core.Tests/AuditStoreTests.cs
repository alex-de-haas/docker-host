namespace Haas.Hosty.Core.Tests;

public sealed class AuditStoreTests
{
    [Fact]
    public async Task ReadRecentAsync_ReturnsNewestFirstAcrossReadBlockBoundaries()
    {
        // The tail reader walks the file in 64 KiB blocks from the end, carrying a line that straddles
        // a boundary into the next block. Enough records to fill several blocks is the only way that
        // carry gets exercised — and getting it wrong would silently drop or splice audit lines.
        var paths = CreatePaths();
        var store = new AuditStore(paths);
        const int written = 600;
        for (var index = 0; index < written; index += 1)
        {
            await store.AppendAsync(CreateRecord(index));
        }

        Assert.True(new FileInfo(paths.AuditLogPath).Length > 64 * 1024, "the log must span more than one read block");

        var recent = await store.ReadRecentAsync(limit: 500);

        Assert.Equal(500, recent.Count);
        Assert.Equal(
            Enumerable.Range(written - 500, 500).Reverse().Select(index => $"audit_{index:D4}"),
            recent.Select(record => record.Id));
    }

    [Fact]
    public async Task ReadRecentAsync_ReadsALogWithNoTrailingNewline()
    {
        // A log left by a crash mid-append, or hand-edited, has no final newline: its last line must
        // still be the first thing a newest-first read returns.
        var paths = CreatePaths();
        Directory.CreateDirectory(Path.GetDirectoryName(paths.AuditLogPath)!);
        var store = new AuditStore(paths);
        await store.AppendAsync(CreateRecord(0));
        await File.AppendAllTextAsync(paths.AuditLogPath, Serialize(CreateRecord(1)));

        var recent = await store.ReadRecentAsync();

        Assert.Equal(["audit_0001", "audit_0000"], recent.Select(record => record.Id));
    }

    [Fact]
    public async Task AppendAsync_RotatesTheLiveLogAndKeepsReadingAcrossTheRotation()
    {
        // Nothing trimmed this file before, so it grew for the life of the host. The cap is 8 MiB, so
        // the oversized log is staged directly rather than appended a line at a time.
        var paths = CreatePaths();
        await StageOversizedLogAsync(paths, CreateRecord(1));

        var store = new AuditStore(paths);
        await store.AppendAsync(CreateRecord(2));

        var rotatedPath = paths.AuditLogPath + ".1";
        Assert.True(File.Exists(rotatedPath), "the oversized log must be rotated aside");
        Assert.True(new FileInfo(paths.AuditLogPath).Length < 64 * 1024, "the live log must start fresh");

        // The rotation must not amputate the window: a read spans the live log and the generation
        // behind it, newest first.
        var recent = await store.ReadRecentAsync();
        Assert.Equal(["audit_0002", "audit_0001", "audit_pad"], recent.Select(record => record.Id));
    }

    [Fact]
    public async Task SearchAsync_FiltersFromTheEndAndReportsTruncationWhenTheLimitFills()
    {
        var paths = CreatePaths();
        var store = new AuditStore(paths);
        for (var index = 0; index < 20; index += 1)
        {
            await store.AppendAsync(CreateRecord(index) with
            {
                Action = index % 2 == 0 ? "auth.login" : "auth.credential.used",
            });
        }

        var result = await store.SearchAsync(
            new AuditQuery(ActionPrefix: "auth.login", Limit: 3),
            DateTimeOffset.Parse("2026-08-26T01:00:00Z"));

        Assert.Equal(["audit_0018", "audit_0016", "audit_0014"], result.Entries.Select(record => record.Id));
        Assert.True(result.Window.Truncated);
    }

    [Fact]
    public async Task SearchAsync_StopsAtTheStartOfTheWindow()
    {
        var paths = CreatePaths();
        var store = new AuditStore(paths);
        await store.AppendAsync(CreateRecord(0) with { CreatedAt = DateTimeOffset.Parse("2026-08-20T00:00:00Z") });
        await store.AppendAsync(CreateRecord(1) with { CreatedAt = DateTimeOffset.Parse("2026-08-26T00:30:00Z") });

        var result = await store.SearchAsync(
            new AuditQuery(RangeSeconds: 3600),
            DateTimeOffset.Parse("2026-08-26T01:00:00Z"));

        Assert.Equal(["audit_0001"], result.Entries.Select(record => record.Id));
        Assert.False(result.Window.Truncated);
    }

    [Fact]
    public async Task ReadRecentAsync_ReturnsNothingWhenNoLogExists()
    {
        Assert.Empty(await new AuditStore(CreatePaths()).ReadRecentAsync());
    }

    [Fact]
    public async Task SearchAsync_ReportsTruncationOnceRotationHasDiscardedAGeneration()
    {
        // Running out of retained trail before reaching the window's start means something different
        // after history has been dropped: older matching events may have existed. Reporting the answer
        // as complete there is exactly the "nothing happened" lie the window exists to prevent.
        var paths = CreatePaths();
        var store = new AuditStore(paths);
        await RotateTwiceAsync(paths, store);

        var result = await store.SearchAsync(
            new AuditQuery(RangeSeconds: 30 * 24 * 60 * 60),
            DateTimeOffset.Parse("2026-08-26T01:00:00Z"));

        Assert.True(File.Exists(paths.AuditLogPath + ".discarded"), "the second rotation drops a generation");
        Assert.True(result.Window.Truncated);
    }

    [Fact]
    public async Task SearchAsync_ReportsACompleteAnswerOnAYoungHost()
    {
        // The control for the test above: exhausting the trail is honest when nothing was ever
        // discarded, and a fresh host must not be told its answer might be missing entries.
        var paths = CreatePaths();
        var store = new AuditStore(paths);
        await store.AppendAsync(CreateRecord(0));

        var result = await store.SearchAsync(
            new AuditQuery(RangeSeconds: 30 * 24 * 60 * 60),
            DateTimeOffset.Parse("2026-08-26T01:00:00Z"));

        Assert.Single(result.Entries);
        Assert.False(result.Window.Truncated);
    }

    [Fact]
    public async Task ReadRecentAsync_ReadsOneSnapshotOfBothGenerations()
    {
        // The reader opens the live log and the rotated generation together, so the pair it walks is
        // fixed. Opening them one after another by path let a rotation in between hand back the inode
        // the walk had just finished — every record twice, and the newest ones missed entirely.
        var paths = CreatePaths();
        var store = new AuditStore(paths);
        await StageOversizedLogAsync(paths, CreateRecord(1));
        await store.AppendAsync(CreateRecord(2));

        var recent = await store.ReadRecentAsync();

        Assert.Equal(recent.Select(record => record.Id).Distinct(), recent.Select(record => record.Id));
        Assert.Equal(["audit_0002", "audit_0001", "audit_pad"], recent.Select(record => record.Id));
    }

    // Fills and rotates the live log twice, so the second rotation overwrites the generation the first
    // one produced — the point at which the trail stops reaching back to the first event.
    private static async Task RotateTwiceAsync(CoreDataPaths paths, AuditStore store)
    {
        await StageOversizedLogAsync(paths, CreateRecord(1));
        await store.AppendAsync(CreateRecord(2));
        await StageOversizedLogAsync(paths, CreateRecord(3));
        await store.AppendAsync(CreateRecord(4));
    }

    // The cap is 8 MiB, so an oversized log is staged directly rather than appended a line at a time.
    private static async Task StageOversizedLogAsync(CoreDataPaths paths, AuditRecord tail)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(paths.AuditLogPath)!);
        var padded = CreateRecord(0) with
        {
            Id = "audit_pad",
            Details = new Dictionary<string, string>(StringComparer.Ordinal) { ["pad"] = new string('x', 9 * 1024 * 1024) },
        };
        await File.WriteAllTextAsync(
            paths.AuditLogPath,
            Serialize(padded) + Environment.NewLine + Serialize(tail) + Environment.NewLine);
    }

    private static string Serialize(AuditRecord record)
        => System.Text.Json.JsonSerializer.Serialize(record, CoreJsonSerializerContext.Default.AuditRecord);

    private static AuditRecord CreateRecord(int index)
        => new(
            Id: $"audit_{index:D4}",
            Action: "auth.login",
            ResourceType: "auth.session",
            ResourceId: null,
            Outcome: "succeeded",
            ActorUserId: "user-1",
            CreatedAt: DateTimeOffset.Parse("2026-08-26T00:30:00Z"),
            Details: new Dictionary<string, string>(StringComparer.Ordinal) { ["index"] = index.ToString() });

    private static CoreDataPaths CreatePaths()
    {
        var root = Path.Combine(Path.GetTempPath(), $"hosty-core-audit-tests-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        return new CoreDataPaths(
            DataRoot: root,
            CoreRoot: Path.Combine(root, "core"),
            AppsRoot: Path.Combine(root, "apps"),
            BackupsRoot: Path.Combine(root, "backups"),
            SourcesRoot: Path.Combine(root, "sources"),
            AuthRoot: Path.Combine(root, "core", "auth"),
            AuditLogPath: Path.Combine(root, "core", "audit", "audit.ndjson"));
    }
}
