using Haas.Hosty.Core;
using Microsoft.Extensions.Logging;

namespace Haas.Hosty.Core.Tests;

public sealed class CoreLogBufferTests
{
    private static readonly DateTimeOffset Start = new(2026, 8, 19, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public void Read_ReturnsOldestFirstAndHonoursTail()
    {
        var ring = new CoreLogRing(10);
        for (var index = 0; index < 5; index++)
        {
            ring.Add(Start.AddSeconds(index), LogLevel.Information, "Haas.Hosty.Core.Test", $"m{index}", null);
        }

        var records = ring.Read(tail: 3, minLevel: LogLevel.Trace);

        Assert.Equal(["m2", "m3", "m4"], records.Select(record => record.Message));
    }

    [Fact]
    public void Add_DropsTheOldestRecordAtCapacity()
    {
        var ring = new CoreLogRing(3);
        for (var index = 0; index < 5; index++)
        {
            ring.Add(Start.AddSeconds(index), LogLevel.Information, "Haas.Hosty.Core.Test", $"m{index}", null);
        }

        var records = ring.Read(tail: 100, minLevel: LogLevel.Trace);

        Assert.Equal(["m2", "m3", "m4"], records.Select(record => record.Message));
        Assert.Equal([3L, 4L, 5L], records.Select(record => record.Sequence));
    }

    // The DockerStatsExposition case: a tick that warns every 10 s must not cost a slot per tick, or a
    // Docker outage evicts the whole ring with 360 copies of one line an hour.
    [Fact]
    public void Add_FoldsARepeatIntoTheNewestRecord()
    {
        var ring = new CoreLogRing(10);
        ring.Add(Start, LogLevel.Warning, "Haas.Hosty.Core.Stats", "tick failed", null);
        ring.Add(Start.AddSeconds(10), LogLevel.Warning, "Haas.Hosty.Core.Stats", "tick failed", null);
        ring.Add(Start.AddSeconds(20), LogLevel.Warning, "Haas.Hosty.Core.Stats", "tick failed", null);

        var record = Assert.Single(ring.Read(tail: 100, minLevel: LogLevel.Trace));

        Assert.Equal(3, record.Count);
        Assert.Equal(Start, record.Timestamp);
        Assert.Equal(Start.AddSeconds(20), record.LastSeen);
        Assert.Equal(1L, record.Sequence);
    }

    [Fact]
    public void Add_DoesNotFoldWhenAnotherRecordCameBetween()
    {
        var ring = new CoreLogRing(10);
        ring.Add(Start, LogLevel.Warning, "Haas.Hosty.Core.Stats", "tick failed", null);
        ring.Add(Start.AddSeconds(1), LogLevel.Information, "Haas.Hosty.Core.Apps", "app started", null);
        ring.Add(Start.AddSeconds(2), LogLevel.Warning, "Haas.Hosty.Core.Stats", "tick failed", null);

        var records = ring.Read(tail: 100, minLevel: LogLevel.Trace);

        Assert.Equal(3, records.Count);
        Assert.All(records, record => Assert.Equal(1, record.Count));
    }

    [Fact]
    public void Add_TreatsADifferentExceptionAsADifferentRecord()
    {
        var ring = new CoreLogRing(10);
        ring.Add(Start, LogLevel.Error, "Haas.Hosty.Core.Test", "boom", "System.InvalidOperationException: a");
        ring.Add(Start.AddSeconds(1), LogLevel.Error, "Haas.Hosty.Core.Test", "boom", "System.InvalidOperationException: b");

        Assert.Equal(2, ring.Read(tail: 100, minLevel: LogLevel.Trace).Count);
    }

    [Fact]
    public void Read_FiltersByMinimumLevel()
    {
        var ring = new CoreLogRing(10);
        ring.Add(Start, LogLevel.Information, "Haas.Hosty.Core.Test", "info", null);
        ring.Add(Start.AddSeconds(1), LogLevel.Warning, "Haas.Hosty.Core.Test", "warn", null);
        ring.Add(Start.AddSeconds(2), LogLevel.Error, "Haas.Hosty.Core.Test", "error", null);

        var records = ring.Read(tail: 100, minLevel: LogLevel.Warning);

        Assert.Equal(["warn", "error"], records.Select(record => record.Message));
    }

    [Fact]
    public void ReadAfter_ResumesFromTheCursorAndRespectsTheLimit()
    {
        var ring = new CoreLogRing(10);
        for (var index = 0; index < 5; index++)
        {
            ring.Add(Start.AddSeconds(index), LogLevel.Information, "Haas.Hosty.Core.Test", $"m{index}", null);
        }

        var page = ring.ReadAfter(afterSequence: 2, limit: 2, minLevel: LogLevel.Trace);

        Assert.Equal(["m2", "m3"], page.Select(record => record.Message));
        Assert.Equal([3L, 4L], page.Select(record => record.Sequence));
    }

    [Fact]
    public void ReadAfter_ReturnsNothingWhenTheCursorIsCurrent()
    {
        var ring = new CoreLogRing(10);
        ring.Add(Start, LogLevel.Information, "Haas.Hosty.Core.Test", "m0", null);

        Assert.Empty(ring.ReadAfter(afterSequence: 1, limit: 100, minLevel: LogLevel.Trace));
    }

    [Theory]
    [InlineData("Microsoft.AspNetCore.Hosting.Diagnostics", true)]
    [InlineData("Microsoft.Hosting.Lifetime", true)]
    [InlineData("System.Net.Http.HttpClient.registry-digest.ClientHandler", true)]
    [InlineData("Haas.Hosty.Core.RuntimeAppSupervisorService", false)]
    [InlineData("ModelContextProtocol.Server.McpServer", false)]
    [InlineData("SystemLooking.Custom", false)]
    public void IsFrameworkCategory_SplitsTheFrameworkFromEverythingElse(string category, bool framework)
        => Assert.Equal(framework, CoreLogBuffer.IsFrameworkCategory(category));

    [Fact]
    public void Add_RoutesFrameworkRecordsAwayFromCoresOwnRing()
    {
        var buffer = new CoreLogBuffer();
        buffer.Add(Start, LogLevel.Information, "Microsoft.AspNetCore.Hosting.Diagnostics", "Request finished", null);
        buffer.Add(Start.AddSeconds(1), LogLevel.Information, "Haas.Hosty.Core.Apps", "app started", null);

        var hosty = buffer.Ring(CoreLogRingKind.Hosty).Read(tail: 100, minLevel: LogLevel.Trace);
        var framework = buffer.Ring(CoreLogRingKind.Framework).Read(tail: 100, minLevel: LogLevel.Trace);

        Assert.Equal("app started", Assert.Single(hosty).Message);
        Assert.Equal("Request finished", Assert.Single(framework).Message);
    }

    // The rings die with the process, so a cursor holder has to be able to tell a quiet Core from a
    // restarted one.
    [Fact]
    public void RunId_DiffersBetweenBuffers()
        => Assert.NotEqual(new CoreLogBuffer().RunId, new CoreLogBuffer().RunId);
}

public sealed class CoreLogEndpointsTests
{
    [Fact]
    public void TryParseRing_DefaultsToCoresOwnRecords()
    {
        Assert.True(CoreLogEndpoints.TryParseRing(null, out var kind));
        Assert.Equal(CoreLogRingKind.Hosty, kind);
    }

    // The enum is internal, so the case travels as its wire name rather than in the signature.
    [Theory]
    [InlineData("framework", "framework")]
    [InlineData("HOSTY", "hosty")]
    [InlineData("  hosty  ", "hosty")]
    public void TryParseRing_AcceptsBothRings(string value, string expected)
    {
        Assert.True(CoreLogEndpoints.TryParseRing(value, out var kind));

        Assert.Equal(expected, kind == CoreLogRingKind.Framework ? "framework" : "hosty");
    }

    [Fact]
    public void TryParseRing_RejectsAnUnknownRing()
        => Assert.False(CoreLogEndpoints.TryParseRing("everything", out _));

    [Theory]
    [InlineData(null, LogLevel.Trace)]
    [InlineData("warn", LogLevel.Warning)]
    [InlineData("Information", LogLevel.Information)]
    [InlineData("critical", LogLevel.Critical)]
    public void TryParseLevel_AcceptsTheDocumentedNames(string? value, LogLevel expected)
    {
        Assert.True(CoreLogEndpoints.TryParseLevel(value, out var level));
        Assert.Equal(expected, level);
    }

    [Fact]
    public void TryParseLevel_RejectsAnUnknownLevel()
        => Assert.False(CoreLogEndpoints.TryParseLevel("loud", out _));
}
