using Microsoft.Extensions.Logging.Abstractions;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Theory]
    [InlineData("{\"files\":{\"mode\":\"ro\",\"service\":\"app\"}}", "{\"files\":{\"mode\":\"rw\",\"service\":\"app\"}}", "mount:files:mode:ro->rw", "read-only → read/write")]
    [InlineData("{\"files\":{\"mode\":\"ro\",\"service\":\"app\"}}", "{\"files\":{\"mode\":\"ro\"}}", "mount:files:service:app->all services", "service scope: app → all services")]
    [InlineData("{\"files\":{\"mode\":\"ro\",\"multiple\":true}}", "{\"files\":{\"mode\":\"ro\",\"multiple\":false}}", "mount:files:multiple:true->false", "multiple bindings: true → false")]
    [InlineData("{\"files\":{\"mode\":\"ro\",\"required\":false}}", "{\"files\":{\"mode\":\"ro\",\"required\":true}}", "mount:files:required:false->true", "required at launch: false → true")]
    public async Task ExternalMountContractChangeRequiresReview_WithReadyBoundPath(string before, string after, string token, string description)
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var initial = await fixture.WriteManifestAsync("1.0.0", externalMountsJson: $"\"externalMounts\":{before},");
        var candidate = await fixture.WriteManifestAsync("2.0.0", externalMountsJson: $"\"externalMounts\":{after},");
        await fixture.Service.InstallAsync(new(initial, Autostart: false));
        var hostPath = CreateExternalDirectory();
        await fixture.Service.ConfigureMountsAsync("com.example.notes", new([new("files", "documents", hostPath)]));
        var plan = await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new(candidate));
        Assert.False(plan.ConfigurationReadiness!.Required);
        Assert.True(plan.RequiresReview);
        Assert.Contains(token, plan.Changes);
        var html = InstallationApprovalEndpoints.Render(new InstallationApproval
        {
            UserId = "admin", CallerName = "Shell", Status = "pending", ExpiresAt = DateTimeOffset.UtcNow.AddMinutes(15), UpdatePlan = plan,
        }, "nonce");
        Assert.Contains(description, html);
        Assert.DoesNotContain(hostPath, html);
        var refused = await Assert.ThrowsAsync<AppLifecycleException>(() => fixture.Service.EnqueueUpdateAsync(plan.AppId, new(plan.PlanDigest), requireRoutine: true));
        Assert.Equal("approval_required", refused.Code);
        Assert.Equal("1.0.0", (await fixture.Apps.GetAppAsync(plan.AppId))!.Version);
        Assert.Null(fixture.Service.TryGetRunningBackgroundUpdate(plan.AppId));
    }

    [Fact]
    public async Task RemovedMountSlotAndReturningRetainedBindingBothRequireReview()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        const string mount = """ "externalMounts":{"files":{"mode":"ro","service":"app"}},""";
        var initial = await fixture.WriteManifestAsync("1.0.0", externalMountsJson: mount);
        var removed = await fixture.WriteManifestAsync("2.0.0");
        var returned = await fixture.WriteManifestAsync("3.0.0", externalMountsJson: mount);
        await fixture.Service.InstallAsync(new(initial, Autostart: false));
        await fixture.Service.ConfigureMountsAsync("com.example.notes", new([new("files", "documents", CreateExternalDirectory())]));
        var removal = await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new(removed));
        Assert.True(removal.RequiresReview);
        Assert.Contains(removal.Changes, change => change.StartsWith("mount:files:removed:"));
        Assert.False(removal.ConfigurationReadiness!.Required);
        await fixture.Service.ApplyUpdateAsync(removal.AppId, new(removal.PlanDigest));
        var installed = (await fixture.Apps.GetAppAsync(removal.AppId))!;
        Assert.Empty(installed.MountSlots!);
        Assert.Single(installed.Mounts!);
        Assert.Empty(RuntimeMountPlanner.Resolve(installed.MountSlots, installed.Mounts));
        var reactivation = await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new(returned));
        Assert.True(reactivation.RequiresReview);
        Assert.Contains(reactivation.Changes, change => change.StartsWith("mount:files:added:"));
        Assert.False(reactivation.ConfigurationReadiness!.Required);
        var refused = await Assert.ThrowsAsync<AppLifecycleException>(() => fixture.Service.EnqueueUpdateAsync(reactivation.AppId, new(reactivation.PlanDigest), requireRoutine: true));
        Assert.Equal("approval_required", refused.Code);
        await fixture.Service.ApplyUpdateAsync(reactivation.AppId, new(reactivation.PlanDigest));
        installed = (await fixture.Apps.GetAppAsync(removal.AppId))!;
        Assert.True(Assert.Single(RuntimeMountPlanner.Resolve(installed.MountSlots, installed.Mounts)).ReadOnly);
    }

    [Fact]
    public async Task LegacyCachedRoutineClassificationCannotAuthorizeMountAccessExpansion()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var initial = await fixture.WriteManifestAsync("1.0.0", externalMountsJson: """ "externalMounts":{"files":{"mode":"ro"}},""");
        var candidate = await fixture.WriteManifestAsync("2.0.0", externalMountsJson: """ "externalMounts":{"files":{"mode":"rw"}},""");
        await fixture.Service.InstallAsync(new(initial, Autostart: false));
        await fixture.Service.ConfigureMountsAsync("com.example.notes", new([new("files", "documents", CreateExternalDirectory())]));
        var plan = await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new(candidate));
        var snapshots = new AppUpdateSnapshotStore(fixture.Paths, NullLogger.Instance);
        await snapshots.ChangeAsync(plan.AppId, snapshot => snapshot! with
        {
            Plan = snapshot.Plan! with { Plan = snapshot.Plan.Plan with
            {
                RequiresReview = false,
                Changes = snapshot.Plan.Plan.Changes.Where(change => !change.StartsWith("mount:")).ToArray(),
            } },
        });
        var restarted = fixture.RecreateService();
        var persisted = await restarted.GetReviewedUpdatePlanAsync(plan.AppId, plan.PlanDigest);
        Assert.False(persisted.RequiresReview);
        Assert.DoesNotContain(persisted.Changes, change => change.StartsWith("mount:"));
        // Both delegated and direct queued operators re-check authoritative mount declarations.
        foreach (var requireRoutine in new[] { false, true })
        {
            var refused = await Assert.ThrowsAsync<AppLifecycleException>(() => restarted.EnqueueUpdateAsync(plan.AppId, new(plan.PlanDigest), requireRoutine: requireRoutine));
            Assert.Equal("approval_required", refused.Code);
        }
        Assert.Equal("1.0.0", (await fixture.Apps.GetAppAsync(plan.AppId))!.Version);
        Assert.Null(restarted.TryGetRunningBackgroundUpdate(plan.AppId));
        // Trusted Core consent/control apply still consumes the exact reviewed candidate.
        await restarted.ApplyUpdateAsync(plan.AppId, new(plan.PlanDigest));
        Assert.Equal("rw", Assert.Single((await fixture.Apps.GetAppAsync(plan.AppId))!.MountSlots!).Mode);
    }

    [Fact]
    public async Task UnchangedMountDeclarationsPreserveRoutineReleaseClassification()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        const string mount = """ "externalMounts":{"files":{"mode":"ro","service":"app"}},""";
        var initial = await fixture.WriteManifestAsync("1.0.0", externalMountsJson: mount);
        var candidate = await fixture.WriteManifestAsync("2.0.0", externalMountsJson: mount);
        await fixture.Service.InstallAsync(new(initial, Autostart: false));
        await fixture.Service.ConfigureMountsAsync("com.example.notes", new([new("files", "documents", CreateExternalDirectory())]));
        var plan = await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new(candidate));
        Assert.False(plan.RequiresReview);
        Assert.DoesNotContain(plan.Changes, change => change.StartsWith("mount:"));
    }
}
