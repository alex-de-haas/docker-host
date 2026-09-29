using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Fact]
    public async Task OptionalPermissionsRemainUnselected_AndReviewedChangesSurviveRestart()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var folder = Path.Combine(fixture.Root, "optional-permissions");
        Directory.CreateDirectory(folder);
        var path = Path.Combine(folder, "manifest.json");
        const string manifest = """
            {"schemaVersion":"app.0.1","id":"example.consumer","name":"Consumer","version":"0.1.0",
             "corePermissions":["apps.skills.read"],"optionalCorePermissions":["providers.speech-to-text"],
             "runtimeProfiles":[{"key":"dev","type":"localCommand","development":true,"default":true}],"defaultRuntime":"dev",
             "services":[{"key":"app","runtimes":{"dev":{"type":"localCommand","command":"echo unused","workingDirectory":"."}}}]}
            """;
        await File.WriteAllTextAsync(path, manifest);
        await fixture.Service.InstallAsync(new(path, Autostart: false));
        var app = (await fixture.Service.ListAppsAsync()).Single();
        Assert.Equal([CoreAppPermissions.ReadSkills], app.GrantedCorePermissions);
        // Install/update review advertises optional authority separately from mandatory authority.
        var plan = await fixture.Service.CreateUpdatePlanAsync(app.Id, new(path));
        Assert.Equal([CoreAppPermissions.SpeechProviders], plan.TargetOptionalCorePermissions);
        await fixture.Service.ApplyUpdateAsync(app.Id, new(plan.PlanDigest, OptionalPermissions: [CoreAppPermissions.SpeechProviders]));
        Assert.Contains(CoreAppPermissions.SpeechProviders, (await fixture.RecreateService().ListAppsAsync()).Single().GrantedCorePermissions!);
        // Previously accepted optional authority still needs review before becoming mandatory.
        await File.WriteAllTextAsync(path, manifest.Replace("\"corePermissions\":[\"apps.skills.read\"]", "\"corePermissions\":[\"apps.skills.read\",\"providers.speech-to-text\"]")
            .Replace("\"optionalCorePermissions\":[\"providers.speech-to-text\"]", "\"optionalCorePermissions\":[]"));
        var required = await fixture.Service.CreateUpdatePlanAsync(app.Id, new(path));
        var refusal = await Assert.ThrowsAsync<AppLifecycleException>(() => fixture.Service.EnqueueUpdateAsync(app.Id, new(required.PlanDigest)));
        Assert.Equal("approval_required", refusal.Code);
        await File.WriteAllTextAsync(path, manifest);
        // A normal update retains the choice; removal of the declaration revokes it.
        var update = await fixture.Service.CreateUpdatePlanAsync(app.Id, new(path));
        await fixture.Service.ApplyUpdateAsync(app.Id, new(update.PlanDigest));
        Assert.Contains(CoreAppPermissions.SpeechProviders, (await fixture.Service.ListAppsAsync()).Single().GrantedCorePermissions!);
        await File.WriteAllTextAsync(path, manifest.Replace("\"optionalCorePermissions\":[\"providers.speech-to-text\"]", "\"optionalCorePermissions\":[]"));
        var remove = await fixture.Service.CreateUpdatePlanAsync(app.Id, new(path));
        await fixture.Service.ApplyUpdateAsync(app.Id, new(remove.PlanDigest));
        Assert.DoesNotContain(CoreAppPermissions.SpeechProviders, (await fixture.Service.ListAppsAsync()).Single().GrantedCorePermissions!);
    }

    [Fact]
    public void OptionalConsentCannotGrantAnUndeclaredPermission()
    {
        Assert.Throws<AppLifecycleException>(() => CoreAppPermissions.ResolveGrants([], [CoreAppPermissions.SpeechProviders], [CoreAppPermissions.Install]));
        var entry = new InstallationApproval
        {
            UserId = "admin", CallerName = "Consumer", ExpiresAt = DateTimeOffset.UtcNow.AddMinutes(5), Status = "pending",
            PermissionPlan = new("example.consumer", "Consumer", DateTimeOffset.UtcNow, "revision", [], [CoreAppPermissions.SpeechProviders], []),
        };
        var html = InstallationApprovalEndpoints.Render(entry, "nonce");
        Assert.Contains("Optional permissions", html);
        Assert.Contains("all current and future speech-to-text providers", html);
        Assert.DoesNotContain(" checked", html);
        Assert.Contains("Save permissions", html);
    }
}
