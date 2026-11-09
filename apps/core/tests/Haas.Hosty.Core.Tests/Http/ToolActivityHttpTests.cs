using System.Net;
using System.Net.Http.Json;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed partial class UiPanelHttpTests
{
    private sealed class ActivityClock : IClock { public DateTimeOffset UtcNow { get; set; } = DateTimeOffset.UtcNow; }

    [Fact]
    public async Task ActivityIsVisibleWithoutOpeningPanels_AndIsUserTargeted()
    {
        await using var host = await Setup();
        using var producer = await Client(host, "target");
        producer.DefaultRequestHeaders.Remove("X-Hosty-User-Token");
        var target = await Target(host);
        var hub = host.Services.GetRequiredService<CoreEventHub>();
        using var own = hub.Subscribe("member", false, toolActivity: true);
        using var other = hub.Subscribe("other", true, toolActivity: true);
        var report = new ToolActivityReport("member", target.Panel.InstallationId, "tool", "needs-you", 2, "Review approvals");
        using var posted = await producer.PostAsJsonAsync("/api/internal/apps/target/ui/activity", report);
        posted.EnsureSuccessStatusCode();
        Assert.True(own.Reader.TryRead(out var hint));
        Assert.Equal(CoreEventHub.ToolActivityChanged, hint!.Name);
        Assert.Equal("{}", hint.Data);
        Assert.False(other.Reader.TryRead(out _));
        using var first = await Client(host);
        using var second = await Client(host);
        foreach (var client in new[] { first, second })
        {
            var activity = Assert.Single((await client.GetFromJsonAsync<ToolActivityList>("/api/internal/apps/consumer/ui/activity"))!.Activities);
            Assert.Equal("needs-you", activity.State);
            Assert.Equal(2, activity.Count);
            Assert.Equal(target.Panel, activity.Panel);
        }
        // A report's renewal is not a new decision and does not fan out redundant refresh hints.
        (await producer.PostAsJsonAsync("/api/internal/apps/target/ui/activity", report)).EnsureSuccessStatusCode();
        Assert.False(own.Reader.TryRead(out _));
    }

    [Fact]
    public async Task ActivityAuthorizationRechecksActorPanelAndInstallation()
    {
        await using var host = await Setup();
        var target = await Target(host);
        var report = new ToolActivityReport("member", target.Panel.InstallationId, "tool", "failed");
        using var anonymous = host.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.PostAsJsonAsync("/api/internal/apps/target/ui/activity", report)).StatusCode);
        using var wrongApp = await Client(host);
        Assert.Equal(HttpStatusCode.Unauthorized, (await wrongApp.PostAsJsonAsync("/api/internal/apps/target/ui/activity", report)).StatusCode);
        using var producer = await Client(host, "target");
        Assert.Equal(HttpStatusCode.BadRequest, (await producer.PostAsJsonAsync("/api/internal/apps/target/ui/activity", report with { PanelId = "other" })).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await producer.GetAsync("/api/internal/apps/target/ui/activity")).StatusCode);
        await host.Services.GetRequiredService<UserDirectoryStore>().UpdateAsync(state => state with {
            Users = [.. state.Users, state.Users[0] with { Id = "other", Email = "other@example.test" }]
        });
        Assert.Equal(HttpStatusCode.Forbidden, (await producer.PostAsJsonAsync("/api/internal/apps/target/ui/activity", report with { UserId = "other" })).StatusCode);
        (await producer.PostAsJsonAsync("/api/internal/apps/target/ui/activity", report)).EnsureSuccessStatusCode();
        await host.Services.GetRequiredService<AppRegistryStore>().UpdateAppAsync("target", a => a with { InstalledAt = a.InstalledAt.AddSeconds(1) });
        Assert.Equal(HttpStatusCode.Conflict, (await producer.PostAsJsonAsync("/api/internal/apps/target/ui/activity", report)).StatusCode);
        var fresh = Assert.Single((await wrongApp.GetFromJsonAsync<ToolActivityList>("/api/internal/apps/consumer/ui/activity"))!.Activities);
        Assert.Equal("idle", fresh.State);
        Assert.Null(fresh.ReportedAt);
        await host.Services.GetRequiredService<ToolActivityService>().PruneAsync(default);
        await host.Services.GetRequiredService<UserDirectoryStore>().UpdateAsync(state => state with { Assignments = state.Assignments.Where(a => a.AppId != "target").ToArray() });
        Assert.Empty((await wrongApp.GetFromJsonAsync<ToolActivityList>("/api/internal/apps/consumer/ui/activity"))!.Activities);
    }

    [Fact]
    public async Task ActivityWorkingExpires_StickyStatesPersist_StoppedServiceHidesStaleState()
    {
        var clock = new ActivityClock();
        await using var host = await Setup(clock);
        var target = await Target(host);
        using var producer = await Client(host, "target");
        using var consumer = await Client(host);
        var report = new ToolActivityReport("member", target.Panel.InstallationId, "tool", "working");
        async Task<ToolActivity> Read() => Assert.Single((await consumer.GetFromJsonAsync<ToolActivityList>("/api/internal/apps/consumer/ui/activity"))!.Activities);
        (await producer.PostAsJsonAsync("/api/internal/apps/target/ui/activity", report)).EnsureSuccessStatusCode();
        var working = await Read();
        Assert.Equal(clock.UtcNow.AddSeconds(60), working.ExpiresAt);
        clock.UtcNow = clock.UtcNow.AddSeconds(60);
        using var hints = host.Services.GetRequiredService<CoreEventHub>().Subscribe("member", false, toolActivity: true);
        host.Services.GetRequiredService<ToolActivityService>().Expire();
        Assert.True(hints.Reader.TryRead(out _));
        Assert.Equal("idle", (await Read()).State);
        foreach (var state in new[] { "needs-you", "failed" })
        {
            (await producer.PostAsJsonAsync("/api/internal/apps/target/ui/activity", report with { State = state })).EnsureSuccessStatusCode();
            clock.UtcNow = clock.UtcNow.AddMinutes(6);
            Assert.Equal(state, (await Read()).State);
        }
        await host.Services.GetRequiredService<AppRegistryStore>().UpdateAppAsync("target", a => a with {
            Endpoints = [a.Endpoints[0] with { Service = "web" }],
            Health = new("degraded", [new("web", "running", "healthy"), new("other", "exited", null)], clock.UtcNow)
        });
        Assert.Equal("failed", (await Read()).State);
        await host.Services.GetRequiredService<AppRegistryStore>().UpdateAppAsync("target", a => a with {
            Health = new("unhealthy", [new("web", "running", "unhealthy")], clock.UtcNow)
        });
        Assert.Equal("no-connection", (await Read()).State);
        await host.Services.GetRequiredService<AppRegistryStore>().UpdateAppAsync("target", a => a with { RuntimeState = "stopped" });
        var stopped = await Read();
        Assert.Equal("no-connection", stopped.State);
        Assert.NotNull(stopped.ReportedAt);
        Assert.Null(stopped.Count);
        await host.Services.GetRequiredService<AppRegistryStore>().UpdateAppAsync("target", a => a with { RuntimeState = "running", Health = null });
        (await producer.PostAsJsonAsync("/api/internal/apps/target/ui/activity", report with { State = "idle" })).EnsureSuccessStatusCode();
        Assert.Equal("idle", (await Read()).State);
    }

    [Theory]
    [InlineData("bad", null, null)]
    [InlineData("working", 0, null)]
    [InlineData("working", 301, null)]
    [InlineData("needs-you", null, -1)]
    [InlineData("failed", null, 10000)]
    public async Task ActivityRejectsInvalidReports(string state, int? ttl, int? count)
    {
        await using var host = await Setup();
        using var producer = await Client(host, "target");
        var target = await Target(host);
        var response = await producer.PostAsJsonAsync("/api/internal/apps/target/ui/activity",
            new ToolActivityReport("member", target.Panel.InstallationId, "tool", state, count, TtlSeconds: ttl));
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task ActivityForOneAssignedUserIsNeverReturnedToAnotherAssignedUser()
    {
        await using var host = await Setup();
        var now = DateTimeOffset.UtcNow;
        await host.Services.GetRequiredService<UserDirectoryStore>().UpdateAsync(state => state with {
            Users = [.. state.Users, state.Users[0] with { Id = "other", Email = "other@example.test" }],
            Assignments = [.. state.Assignments, new("consumer", "other", now), new("target", "other", now)]
        });
        var target = await Target(host);
        using var producer = await Client(host, "target");
        (await producer.PostAsJsonAsync("/api/internal/apps/target/ui/activity",
            new ToolActivityReport("member", target.Panel.InstallationId, "tool", "failed", Label: "Private decision"))).EnsureSuccessStatusCode();
        using var other = await Client(host);
        other.DefaultRequestHeaders.Remove("X-Hosty-User-Token");
        var identity = await host.Services.GetRequiredService<AppIdentityService>().CreateLaunchTokenAsync("consumer", "other");
        other.DefaultRequestHeaders.Add("X-Hosty-User-Token", identity.AccessToken);
        var visible = Assert.Single((await other.GetFromJsonAsync<ToolActivityList>("/api/internal/apps/consumer/ui/activity"))!.Activities);
        Assert.Equal("idle", visible.State);
        Assert.Null(visible.Label);
        Assert.Null(visible.ReportedAt);
    }
}
