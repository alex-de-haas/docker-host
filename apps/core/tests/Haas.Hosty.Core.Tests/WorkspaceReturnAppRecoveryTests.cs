using System.Text.Json;
using Haas.Hosty.Core;
using Haas.Hosty.Launch;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    private static async Task<(LifecycleFixture Fixture, WorkspaceActivationService Service, WorkspaceRuntimeActivation Activation,
        WorkspaceReturnAppMutation Input)> ReturnAppRecoveryFixture(bool wasRunning = true)
    {
        var fixture = await LifecycleFixture.CreateAsync();
        await fixture.Service.InstallAsync(new AppInstallRequest(await fixture.WriteManifestAsync("1.0.0")));
        if (!wasRunning) await fixture.Service.StartAsync("com.example.notes");
        var workspaces = new DevelopmentWorkspaceService(fixture.Paths, fixture.Apps, fixture.Clock);
        var service = ActivationService(fixture, workspaces);
        var summary = Assert.Single(await fixture.Service.ListAppsAsync());
        var target = WorkspaceReturnAppTarget.Fingerprint(JsonSerializer.SerializeToElement(summary, CoreJsonSerializerContext.Default.AppSummary));
        var request = new WorkspaceReturnRequest(Guid.NewGuid().ToString(), [summary.Id], true, true);
        var activation = new WorkspaceRuntimeActivation(Guid.NewGuid().ToString(), "workspace", "owner", "review", "instance", "revision",
            "tree", "/candidate/Core.csproj", new("release", null, null, 123, DateTimeOffset.UnixEpoch), [summary.Id], "return-core-starting",
            ReturnedApps: [summary.Id], Returns: [new(request, "pending", [new(summary.Id, target, wasRunning, !wasRunning, true)])]);
        WorkspaceRuntimeFiles.Save(fixture.Paths.DataRoot, activation);
        return (fixture, service, activation, new(request.RequestId, summary.Id));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task ReturnAppRecovery_MatchingCapturedTargetRestoresStateAndReplayDoesNotRestart(bool wasRunning)
    {
        var (fixture, service, activation, input) = await ReturnAppRecoveryFixture(wasRunning);
        var starts = fixture.Adapter.StartCount;
        var stops = fixture.Adapter.StopCount;
        var result = await service.RestoreReturnAppAsync(activation.Id, input, default);
        Assert.Equal(wasRunning ? "running" : "stopped", result.App!.RuntimeState);
        Assert.Equal(starts + (wasRunning ? 1 : 0), fixture.Adapter.StartCount);
        Assert.Equal(stops + (wasRunning ? 0 : 1), fixture.Adapter.StopCount);
        Assert.Equal("unchanged", (await service.RestoreReturnAppAsync(activation.Id, input, default)).Status);
        Assert.Equal(starts + (wasRunning ? 1 : 0), fixture.Adapter.StartCount);
        Assert.Equal(stops + (wasRunning ? 0 : 1), fixture.Adapter.StopCount);
    }

    [Theory]
    [InlineData("installation")]
    [InlineData("version")]
    public async Task ReturnAppRecovery_TargetChangedWhileWaitingForAppLockRefusesBeforeLifecycleMutation(string changed)
    {
        var (fixture, service, activation, input) = await ReturnAppRecoveryFixture();
        var mutex = fixture.Apps.OperationLock(input.AppId);
        await mutex.WaitAsync();
        Task<AppLifecycleResponse> recovery;
        try
        {
            recovery = service.RestoreReturnAppAsync(activation.Id, input, default);
            Assert.False(recovery.IsCompleted);
            // A serialized ordinary app operation completes after the helper's earlier observation.
            // It is not protected by the helper's Core lifecycle lock or this group's Core ownership.
            await fixture.Apps.UpdateAppAsync(input.AppId, app => changed == "installation"
                ? app with { InstalledAt = app.InstalledAt.AddSeconds(1) }
                : app with { Version = "2.0.0" });
        }
        finally { mutex.Release(); }
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => recovery);
        Assert.Equal("dev_return_target_changed", error.Code);
        Assert.Equal(0, fixture.Adapter.StartCount);
        Assert.Equal(0, fixture.Adapter.StopCount);
    }

    [Theory]
    [InlineData("completed")]
    [InlineData("replaced")]
    [InlineData("phase")]
    [InlineData("selection")]
    public async Task ReturnAppRecovery_ChangedOrCompletedReceiptRefusesBeforeLifecycleMutation(string changed)
    {
        var (fixture, service, activation, input) = await ReturnAppRecoveryFixture();
        var receipt = activation.Returns![0];
        activation = changed switch
        {
            "completed" => activation with { Returns = [receipt with { State = "succeeded" }] },
            "replaced" => activation with { Returns = [receipt with { Request = receipt.Request with { RequestId = Guid.NewGuid().ToString() } }] },
            "phase" => activation with { Phase = "returned" },
            _ => activation with { Returns = [receipt with { AppsBeforeCoreReturn = [] }] },
        };
        WorkspaceRuntimeFiles.Save(fixture.Paths.DataRoot, activation);
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => service.RestoreReturnAppAsync(activation.Id, input, default));
        Assert.Equal(changed == "selection" ? "activation_return_app_missing" : "activation_return_changed", error.Code);
        Assert.Equal(0, fixture.Adapter.StartCount);
        Assert.Equal(0, fixture.Adapter.StopCount);
    }

    [Fact]
    public async Task ReturnAppRecovery_RevalidatesRetainedAuthorityBeforeLifecycleMutation()
    {
        var (fixture, service, activation, input) = await ReturnAppRecoveryFixture();
        WorkspaceRuntimeFiles.Save(fixture.Paths.DataRoot, activation with { Authority = new("owner", "direct-mcp", Principal: "retired") });
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => service.RestoreReturnAppAsync(activation.Id, input, default));
        Assert.Equal("activation_authority_invalid", error.Code);
        Assert.Equal(0, fixture.Adapter.StartCount);
        Assert.Equal(0, fixture.Adapter.StopCount);
    }
}
