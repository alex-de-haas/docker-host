using System.Text.Json;
using Haas.Hosty.Cli.Commands;
using Haas.Hosty.Launch;

namespace Haas.Hosty.Cli.Tests.Commands;

public sealed class WorkspaceReturnAppRecoveryTests
{
    private static JsonElement Apps(bool running, bool autostart, string source = "/previous", string installation = "install")
        => JsonSerializer.SerializeToElement(new { apps = new[] { new {
            id = "notes", installationId = installation, selectedRuntime = "docker", sourceLivePath = source,
            sourceOverridePath = source, version = "1.0", runtimeState = running ? "running" : "stopped", autostart,
            runtimeProfiles = new[] { new { key = "docker", type = "docker" } }
        } } });

    [Theory]
    [InlineData(true, false)]
    [InlineData(false, true)]
    public async Task WaitsForConflictingBootPolicyThenRestoresCapturedState(bool running, bool autostart)
    {
        var state = Assert.Single(WorkspaceReturnAppRecovery.Capture(Apps(running, autostart), ["notes"]));
        var current = running; var reads = 0; var mutations = 0; var boundary = false;
        await WorkspaceReturnAppRecovery.RestoreAsync([state], () => {
            if (++reads == 2) current = autostart;
            return Task.FromResult(Apps(current, autostart));
        }, (id, desired) => {
            Assert.True(boundary); Assert.Equal("notes", id); Assert.Equal(running, desired);
            mutations++; current = desired; return Task.CompletedTask;
        }, _ => boundary = true, () => { }, interval: TimeSpan.Zero);
        Assert.Equal(running, current); Assert.Equal(1, mutations); Assert.True(reads >= 3);
    }

    [Fact]
    public async Task LostStartResponseUsesDurableBootBoundaryWithoutRestartingAgain()
    {
        var state = Assert.Single(WorkspaceReturnAppRecovery.Capture(Apps(true, false), ["notes"]));
        var current = false; var mutations = 0;
        Task<JsonElement> Read() => Task.FromResult(Apps(current, false));
        Task Change(string id, bool running) { current = running; mutations++; throw new IOException("response lost"); }
        void Boundary(string id) => state = state with { BootObserved = true };
        await Assert.ThrowsAsync<IOException>(() => WorkspaceReturnAppRecovery.RestoreAsync([state], Read, Change, Boundary, () => { }));
        await WorkspaceReturnAppRecovery.RestoreAsync([state], Read, Change, Boundary, () => { });
        Assert.True(current); Assert.Equal(1, mutations);
    }

    [Theory]
    [InlineData("/new-workspace", "install")]
    [InlineData("/previous", "replacement-installation")]
    public async Task ChangedTargetRefusesBeforeAnyLifecycleMutation(string source, string installation)
    {
        var state = Assert.Single(WorkspaceReturnAppRecovery.Capture(Apps(true, false), ["notes"]));
        await Assert.ThrowsAsync<IOException>(() => WorkspaceReturnAppRecovery.RestoreAsync([state],
            () => Task.FromResult(Apps(false, false, source, installation)),
            (_, _) => throw new InvalidOperationException("Must not mutate another target"), _ => { }, () => { }));
    }

    [Fact]
    public async Task UnobservedBootBoundaryRemainsRecoverableWithoutDeclaringSuccess()
    {
        var state = Assert.Single(WorkspaceReturnAppRecovery.Capture(Apps(true, false), ["notes"]));
        await Assert.ThrowsAsync<IOException>(() => WorkspaceReturnAppRecovery.RestoreAsync([state],
            () => Task.FromResult(Apps(true, false)), (_, _) => throw new InvalidOperationException("Too early"),
            _ => throw new InvalidOperationException("No boot boundary"), () => { }, timeout: TimeSpan.Zero));
    }
    [Fact]
    public async Task GuardedRecoveryUsesRetainedRequestAndAppSelection()
    {
        var activation = Guid.NewGuid().ToString(); var request = Guid.NewGuid().ToString();
        await WorkspaceReturnAppRecovery.RestoreTargetAsync((path, body) =>
        {
            Assert.Equal("workspace-activations/" + activation + "/restore-app", path);
            Assert.Equal(request, body.GetProperty("requestId").GetString());
            Assert.Equal("notes", body.GetProperty("appId").GetString());
            Assert.Equal(2, body.EnumerateObject().Count());
            return Task.CompletedTask;
        }, activation, request, "notes");
    }

    [Fact]
    public async Task OlderCoreWithoutGuardedRecoveryLeavesReturnPendingWithoutGenericFallback()
    {
        var attempts = new List<string>();
        var error = await Assert.ThrowsAsync<IOException>(() => WorkspaceReturnAppRecovery.RestoreTargetAsync((path, _) =>
        {
            attempts.Add(path);
            throw new CoreControlException("POST", path, System.Net.HttpStatusCode.NotFound, "");
        }, "activation", "return", "notes"));
        Assert.Single(attempts);
        Assert.DoesNotContain(attempts, p => p.StartsWith("apps/", StringComparison.Ordinal));
        Assert.Contains("Return remains pending", error.Message);
    }

}
