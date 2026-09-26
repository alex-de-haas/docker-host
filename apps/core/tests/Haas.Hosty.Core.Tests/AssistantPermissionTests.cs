using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task AssistantRoleRequiresReviewedUpdate_AndSourceProjectionCannotGrantIt(bool addSkillPermission)
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var folder = Path.Combine(fixture.Root, "assistant-permissions");
        Directory.CreateDirectory(folder);
        var path = Path.Combine(folder, "manifest.json");
        const string manifest = """
            {"schemaVersion":"app.0.1","id":"example.assistant","name":"Assistant","version":"1.0.0",
             "provides":[],"corePermissions":[],
             "runtimeProfiles":[{"key":"dev","type":"localCommand","development":true,"default":true}],"defaultRuntime":"dev",
             "services":[{"key":"app","runtimes":{"dev":{"type":"localCommand","command":"echo unused","workingDirectory":"."}}}]}
            """;
        await File.WriteAllTextAsync(path, manifest);
        await fixture.Service.InstallAsync(new AppInstallRequest(path, Autostart: false));
        var changed = manifest.Replace("\"provides\":[]", "\"provides\":[\"assistant\"]");
        if (addSkillPermission) changed = changed.Replace("\"corePermissions\":[]", "\"corePermissions\":[\"apps.skills.read\"]");
        await File.WriteAllTextAsync(path, changed);
        var restarted = fixture.RecreateService();
        await restarted.BackfillManifestProjectionsAsync();
        var before = Assert.Single(await restarted.ListAppsAsync());
        Assert.Empty(before.ConfirmedRoles!);
        Assert.Empty(before.GrantedCorePermissions!);
        var plan = await restarted.CreateUpdatePlanAsync(before.Id, new(path));
        Assert.True(plan.RequiresReview);
        Assert.Equal([PlatformCapabilities.Assistant], plan.TargetRoles);
        Assert.Empty(plan.CurrentConfirmedRoles);
        Assert.Contains(plan.Changes, change => change.StartsWith("Provider role added:"));
        var refused = await Assert.ThrowsAsync<AppLifecycleException>(() => restarted.EnqueueUpdateAsync(before.Id, new(plan.PlanDigest)));
        Assert.Equal("approval_required", refused.Code);
        // The operator/control-channel apply uses the frozen reviewed target.
        await restarted.ApplyUpdateAsync(before.Id, new(plan.PlanDigest));
        var granted = Assert.Single(await restarted.ListAppsAsync());
        Assert.Equal([PlatformCapabilities.Assistant], granted.ConfirmedRoles);
        Assert.Equal(addSkillPermission ? [CoreAppPermissions.ReadSkills] : Array.Empty<string>(), granted.GrantedCorePermissions);
        await File.WriteAllTextAsync(path, manifest);
        var remove = await restarted.CreateUpdatePlanAsync(before.Id, new(path));
        Assert.Contains(remove.Changes, change => change.StartsWith("Provider role removed:"));
        await restarted.ApplyUpdateAsync(before.Id, new(remove.PlanDigest));
        var revoked = Assert.Single(await fixture.RecreateService().ListAppsAsync());
        Assert.Empty(revoked.ConfirmedRoles!);
        Assert.Empty(revoked.GrantedCorePermissions!);
    }

    [Fact]
    public void AssistantReviewExplainsRolesAndMarksAdditions()
    {
        var entry = new InstallationApproval
        {
            UserId = "admin", CallerName = "Shell", Status = "pending", ExpiresAt = DateTimeOffset.UtcNow.AddMinutes(10),
            UpdatePlan = new AppUpdatePlan("example.assistant", "1", "2", "dev", "dev", "manifest", "digest", "plan", false, [])
            {
                TargetRoles = [PlatformCapabilities.Assistant], TargetCorePermissions = [CoreAppPermissions.ReadSkills],
            },
        };
        var html = InstallationApprovalEndpoints.Render(entry, "nonce");
        Assert.Contains("Provide an assistant", html);
        Assert.Contains("Read agent skills", html);
        Assert.Equal(2, html.Split("(new)").Length - 1);
    }
}
