namespace Haas.Hosty.Core.Tests;

public sealed class AuditStoreTests
{
    [Theory]
    [InlineData("auth.login.succeeded", "email")]
    [InlineData("auth.bootstrap.completed", "email")]
    [InlineData("auth.invitation.accepted", "invitationId")]
    [InlineData("auth.credential.created", "scopes")]
    [InlineData("auth.credential.used", "tool")]
    [InlineData("auth.oauth.token", "client")]
    [InlineData("auth.delegated-token.exchange", "callerAppId")]
    [InlineData("auth.delegated-token.on-behalf-of", "targetAppId")]
    [InlineData("auth.delegated-token.control", "requestedUser")]
    [InlineData("auth.app-code.exchange", "callingAppId")]
    [InlineData("auth.app-sign-in", "reason")]
    [InlineData("auth.assistant-mcp.issue", "callerAppId")]
    [InlineData("auth.user.connection.created", "kind")]
    [InlineData("auth.user.retention.cleanup", "purged")]
    [InlineData("notification.publish", "recipients")]
    [InlineData("notification.retention.cleanup", "pruned")]
    [InlineData("backup.app.create", "appId")]
    [InlineData("backup.retention.cleanup", "planDigest")]
    [InlineData("development.workspace.prepare", "requestId")]
    [InlineData("agent.policy.updated", "approvedSkills")]
    [InlineData("app.installation.approval", "removalOptions")]
    [InlineData("app.permissions.approval", "selectedOptionalPermissions")]
    [InlineData("app.mcp.approval", "assistantTarget")]
    [InlineData("app.lifecycle.stop", "operationId")]
    [InlineData("core.lifecycle.restart", "operation")]
    [InlineData("app.ai_action_approved", "toolName")]
    public async Task AppendAsync_AllProducerSchemasKeepMetadataButOmitUnreviewedCredentialFields(string action, string metadataKey)
    {
        var paths = CreatePaths();
        var store = new AuditStore(paths);
        const string credential = "credential-canary-not-for-export";
        await store.AppendAsync(CreateRecord(1) with
        {
            Action = action,
            Outcome = action == "app.ai_action_approved" ? "reported" : "succeeded",
            Details = new Dictionary<string, string>
            {
                [metadataKey] = "reviewed-metadata",
                ["Authorization"] = "Bearer " + credential,
                ["password"] = credential,
                ["accessToken"] = credential,
                ["refresh_token"] = credential,
                ["requestBody"] = credential,
                ["settings"] = credential,
                ["exception"] = credential,
                ["futureUnreviewedField"] = credential,
            },
        });

        var entry = Assert.Single(await store.ReadRecentAsync());
        Assert.Equal("reviewed-metadata", Assert.Single(entry.Details).Value);
        Assert.Equal(metadataKey, Assert.Single(entry.Details).Key);
        Assert.DoesNotContain(credential, await File.ReadAllTextAsync(paths.AuditLogPath));
    }

    [Fact]
    public async Task AppendAsync_UnknownSchemasAreEmptyAndSessionIdsAreNonReplayable()
    {
        var paths = CreatePaths();
        var store = new AuditStore(paths);
        const string session = "opaque-live-browser-session-canary";
        await store.AppendAsync(CreateRecord(1) with { Action = "future.new-writer", Details = new Dictionary<string, string> { ["email"] = session } });
        await store.AppendAsync(CreateRecord(2) with
        {
            Action = "app.ai_session_created", Outcome = "reported",
            Details = new Dictionary<string, string> { ["sessionId"] = session, ["toolName"] = "Read\n" + new string('x', 6000) },
        });
        var records = await store.ReadRecentAsync();
        Assert.Empty(records[1].Details);
        Assert.Equal(CoreSessionAuthorization.FingerprintSessionId(session), records[0].Details["sessionFingerprint"]);
        Assert.DoesNotContain("sessionId", records[0].Details.Keys);
        Assert.DoesNotContain('\n', records[0].Details["toolName"]);
        Assert.InRange(records[0].Details["toolName"].Length, 1, 4096);
        Assert.DoesNotContain(session, await File.ReadAllTextAsync(paths.AuditLogPath));
    }

    [Fact]
    public async Task SearchAsync_FiltersBothTimeBoundsWithoutAssumingTimestampOrder()
    {
        var now = DateTimeOffset.Parse("2026-08-26T01:00:00Z");
        var store = new AuditStore(CreatePaths());
        await store.AppendAsync(CreateRecord(0) with { CreatedAt = now.AddMinutes(-2) });
        await store.AppendAsync(CreateRecord(1) with { CreatedAt = now.AddHours(-2) });
        await store.AppendAsync(CreateRecord(2) with { CreatedAt = now.AddMinutes(1) });
        await store.AppendAsync(CreateRecord(3) with { CreatedAt = now.AddHours(-1) });
        await store.AppendAsync(CreateRecord(4) with { CreatedAt = now });
        var result = await store.SearchAsync(new AuditQuery(RangeSeconds: 3600), now);
        Assert.Equal(["audit_0004", "audit_0003", "audit_0000"], result.Entries.Select(e => e.Id));
        Assert.False(result.Window.Truncated);
    }

    [Theory]
    [InlineData(-1, -1, 60, 1, true)]
    [InlineData(60, 1, 60, 1, false)]
    [InlineData(2592000, 200, 2592000, 200, false)]
    [InlineData(int.MaxValue, int.MaxValue, 2592000, 200, true)]
    public async Task SearchAsync_ReportsLowerAndUpperBoundsEvenWhenEmpty(int range, int limit, int actualRange, int actualLimit, bool clamped)
    {
        var result = await new AuditStore(CreatePaths()).SearchAsync(new AuditQuery(RangeSeconds: range, Limit: limit), DateTimeOffset.UtcNow);
        Assert.Empty(result.Entries);
        Assert.Equal(actualRange, result.Window.RangeSeconds);
        Assert.Equal(actualLimit, result.Window.Limit);
        Assert.Equal(clamped, result.Window.RangeClamped);
        Assert.Equal(clamped, result.Window.LimitClamped);
        Assert.Equal(0, result.Window.Returned);
        Assert.False(result.Window.Truncated);
    }

    [Fact]
    public async Task SearchAsync_CombinesFiltersAndReportsScanCeilingForNonMatchingEntries()
    {
        var store = new AuditStore(CreatePaths());
        var now = DateTimeOffset.Parse("2026-08-26T01:00:00Z");
        await store.AppendAsync(CreateRecord(0) with { ResourceId = "target", Outcome = "refused" });
        await store.AppendAsync(CreateRecord(1) with { ResourceId = "target", Outcome = "succeeded" });
        await store.AppendAsync(CreateRecord(2) with { ResourceId = "other", Outcome = "refused" });
        await store.AppendAsync(CreateRecord(3) with { ResourceId = "target", Outcome = "refused", Action = "notification.publish" });
        var query = new AuditQuery(ResourceId: "target", ActionPrefix: "auth.", Outcome: "REFUSED");
        var complete = await store.SearchAsync(query, now);
        Assert.Equal("audit_0000", Assert.Single(complete.Entries).Id);
        Assert.False(complete.Window.Truncated);
        var bounded = await store.SearchAsync(query, now, scanCeiling: 2);
        Assert.Empty(bounded.Entries);
        Assert.True(bounded.Window.Truncated);
        Assert.Empty((await store.SearchAsync(query with { ActionPrefix = "absent" }, now)).Entries);
        Assert.Empty((await store.SearchAsync(query with { Outcome = "absent" }, now)).Entries);
    }

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
