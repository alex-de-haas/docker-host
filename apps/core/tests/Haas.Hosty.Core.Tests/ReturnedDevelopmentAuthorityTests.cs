using System.Text.Json.Nodes;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    private static async Task<(LifecycleFixture Fixture, WorkspaceOwner Owner, DevelopmentWorkspaceService Workspaces,
        DevelopmentWorkspace Tree)> ScopedDevelopmentAuthorityFixture(bool withRole = false, bool requiredPackagePermission = false)
    {
        var (f, owner, workspaces, tree, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, tree);
        var app = (await f.Apps.GetAppAsync("test.created"))!;
        await EditDevManifest(Path.GetDirectoryName(app.ManifestPath!)!, manifest =>
            manifest[requiredPackagePermission ? "corePermissions" : "optionalCorePermissions"] = new JsonArray(CoreAppPermissions.ManageSkills));
        await EditDevManifest(tree.Path, manifest =>
        {
            manifest["corePermissions"] = new JsonArray(CoreAppPermissions.ManageSkills);
            if (withRole) manifest["provides"] = new JsonArray(PlatformCapabilities.Assistant);
        });
        var review = await SelectDevelopmentAuthorityTarget(f, f.Service, owner, tree);
        Assert.Equal("review-required", review.State);
        await f.Service.ApproveWorkspaceManifestAsync(review.Review!.WorkspaceManifest!, owner.UserId, [], default);
        Assert.Equal("completed", (await f.Service.ExecuteTargetAsync(review, default)).State);
        app = (await f.Apps.GetAppAsync(app.Id))!;
        var operation = (await AppDevStore.ReadAsync(f.Paths, app, default))!;
        Assert.Equal("active", operation.Phase);
        Assert.DoesNotContain(CoreAppPermissions.ManageSkills, operation.BaseGrantedPermissions ?? []);
        Assert.Contains(CoreAppPermissions.ManageSkills, operation.ExecutionGrantedPermissions ?? []);
        if (withRole)
        {
            Assert.DoesNotContain(PlatformCapabilities.Assistant, operation.BaseConfirmedRoles ?? []);
            Assert.Contains(PlatformCapabilities.Assistant, operation.ExecutionConfirmedRoles ?? []);
        }
        return (f, owner, workspaces, tree);
    }

    private static async Task<AppExecutionOperation> SelectDevelopmentAuthorityTarget(LifecycleFixture f,
        CoreLifecycleService service, WorkspaceOwner owner, DevelopmentWorkspace tree, string kind = "workspace")
        => await service.ExecuteTargetAsync(await ExecutionRequest(f, owner, kind, tree,
            runtime: kind == "workspace" ? "dev" : "docker"), default);

    private static async Task<AppDevOperation> ReturnDevelopmentAuthorityToPackage(LifecycleFixture f,
        CoreLifecycleService service, WorkspaceOwner owner, DevelopmentWorkspace tree)
    {
        Assert.Equal("completed", (await SelectDevelopmentAuthorityTarget(f, service, owner, tree, "package")).State);
        var app = (await f.Apps.GetAppAsync("test.created"))!;
        var operation = (await AppDevStore.ReadAsync(f.Paths, app, default))!;
        Assert.Equal("returned", operation.Phase);
        Assert.Equal(operation.Id, app.DevModeId);
        return operation;
    }

    private static async Task ApprovePermanentPackageSkill(CoreLifecycleService service)
    {
        var plan = await service.CreatePermissionPlanAsync("test.created", default);
        Assert.Contains(CoreAppPermissions.ManageSkills, plan.Required.Concat(plan.Optional));
        await service.ApplyOptionalPermissionsAsync(plan,
            plan.Optional.Contains(CoreAppPermissions.ManageSkills) ? [CoreAppPermissions.ManageSkills] : [], default);
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    [InlineData(true, true)]
    public async Task ReturnedDevelopmentAuthority_PermanentPermissionSurvivesRepeatedWorkspaceSwitches(
        bool differentWorkspace, bool requiredPackagePermission)
    {
        var (f, owner, workspaces, first) = await ScopedDevelopmentAuthorityFixture(requiredPackagePermission: requiredPackagePermission);
        var returned = await ReturnDevelopmentAuthorityToPackage(f, f.Service, owner, first);
        Assert.DoesNotContain(CoreAppPermissions.ManageSkills, (await f.Apps.GetAppAsync("test.created"))!.GrantedCorePermissions ?? []);
        await ApprovePermanentPackageSkill(f.RecreateService());
        var target = differentWorkspace ? await AnotherExecutionTree(f, owner, workspaces, first) : first;

        // The retained journal remains necessary for replay, including across service recreation.
        Assert.Equal(returned.Id, (await f.Apps.GetAppAsync("test.created"))!.DevModeId);
        for (var cycle = 0; cycle < 2; cycle++)
        {
            var service = f.RecreateService();
            var app = (await f.Apps.GetAppAsync("test.created"))!;
            Assert.Contains(CoreAppPermissions.ManageSkills, app.GrantedCorePermissions!);
            var candidate = await service.PrepareExecutionCandidateAsync(app, target.Path, "dev", DevActor(owner), default);
            Assert.False(candidate.ReviewRequired);
            Assert.Contains(CoreAppPermissions.ManageSkills, candidate.Review.BaseGrantedPermissions);
            Assert.Equal("completed", (await SelectDevelopmentAuthorityTarget(f, service, owner, target)).State);
            await ReturnDevelopmentAuthorityToPackage(f, f.RecreateService(), owner, target);
            Assert.Contains(CoreAppPermissions.ManageSkills, (await f.Apps.GetAppAsync(app.Id))!.GrantedCorePermissions!);
        }
    }

    [Fact]
    public async Task ReturnedDevelopmentAuthority_ReviewedPackageRoleSurvivesWorkspaceAndReturn()
    {
        var (f, owner, workspaces, first) = await ScopedDevelopmentAuthorityFixture(withRole: true);
        var returned = await ReturnDevelopmentAuthorityToPackage(f, f.Service, owner, first);
        var app = (await f.Apps.GetAppAsync("test.created"))!;
        Assert.DoesNotContain(PlatformCapabilities.Assistant, app.ConfirmedRoles ?? []);
        var service = f.RecreateService();
        await ApprovePermanentPackageSkill(service);
        var manifest = JsonNode.Parse(await File.ReadAllTextAsync(app.ManifestPath!))!.AsObject();
        manifest["version"] = "0.2.0";
        manifest["provides"] = new JsonArray(PlatformCapabilities.Assistant);
        var updateRoot = Path.Combine(f.Root, "permanent-role-update");
        Directory.CreateDirectory(updateRoot);
        var updatePath = Path.Combine(updateRoot, "manifest.json");
        await File.WriteAllTextAsync(updatePath, manifest.ToJsonString());
        var update = await service.CreateUpdatePlanAsync(app.Id, new(ManifestPath: updatePath, SelectedRuntime: "docker"));
        Assert.True(update.SourceConfigured);
        Assert.Null(update.Error);
        Assert.Contains(PlatformCapabilities.Assistant, update.TargetRoles);
        await service.ApplyUpdateAsync(app.Id, new(update.PlanDigest, ManifestPath: updatePath, SelectedRuntime: "docker"));
        app = (await f.Apps.GetAppAsync(app.Id))!;
        Assert.Equal(returned.Id, app.DevModeId);
        Assert.Contains(PlatformCapabilities.Assistant, app.ConfirmedRoles!);
        var second = await AnotherExecutionTree(f, owner, workspaces, first);

        foreach (var tree in new[] { first, second })
        {
            service = f.RecreateService();
            app = (await f.Apps.GetAppAsync(app.Id))!;
            var candidate = await service.PrepareExecutionCandidateAsync(app, tree.Path, "dev", DevActor(owner), default);
            Assert.False(candidate.ReviewRequired);
            Assert.Contains(PlatformCapabilities.Assistant, candidate.Review.BaseConfirmedRoles);
            Assert.Equal("completed", (await SelectDevelopmentAuthorityTarget(f, service, owner, tree)).State);
            await ReturnDevelopmentAuthorityToPackage(f, f.RecreateService(), owner, tree);
            Assert.Contains(PlatformCapabilities.Assistant, (await f.Apps.GetAppAsync(app.Id))!.ConfirmedRoles!);
        }
    }

    [Fact]
    public async Task ReturnedDevelopmentAuthority_RevokedPermanentPermissionStillRequiresReview()
    {
        var (f, owner, _, tree) = await ScopedDevelopmentAuthorityFixture();
        await ReturnDevelopmentAuthorityToPackage(f, f.Service, owner, tree);
        var service = f.RecreateService();
        await ApprovePermanentPackageSkill(service);
        await service.ApplyOptionalPermissionsAsync(await service.CreatePermissionPlanAsync("test.created", default), [], default);
        service = f.RecreateService();
        var app = (await f.Apps.GetAppAsync("test.created"))!;
        var starts = f.Adapter.StartCount;
        var stops = f.Adapter.StopCount;
        var candidate = await service.PrepareExecutionCandidateAsync(app, tree.Path, "dev", DevActor(owner), default);
        Assert.True(candidate.ReviewRequired);
        Assert.DoesNotContain(CoreAppPermissions.ManageSkills, candidate.GrantedPermissions);
        Assert.Equal("review-required", (await SelectDevelopmentAuthorityTarget(f, service, owner, tree)).State);
        Assert.Equal(starts, f.Adapter.StartCount);
        Assert.Equal(stops, f.Adapter.StopCount);
        Assert.DoesNotContain(CoreAppPermissions.ManageSkills, (await f.Apps.GetAppAsync(app.Id))!.GrantedCorePermissions ?? []);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ReturnedDevelopmentAuthority_ActiveWorkspaceRightsRemainScopedAndRespectRevocation(bool revoke)
    {
        var (f, owner, _, tree) = await ScopedDevelopmentAuthorityFixture(withRole: true);
        if (revoke)
            await f.Apps.UpdateAppAsync("test.created", current => current with {
                GrantedCorePermissions = [], ConfirmedRoles = [], PermissionRevision = Guid.NewGuid().ToString("N") });
        var service = f.RecreateService();
        var app = (await f.Apps.GetAppAsync("test.created"))!;
        var candidate = await service.PrepareExecutionCandidateAsync(app, tree.Path, "dev", DevActor(owner), default);
        Assert.Equal(revoke, candidate.ReviewRequired);
        if (revoke)
        {
            Assert.DoesNotContain(CoreAppPermissions.ManageSkills, candidate.GrantedPermissions);
            Assert.DoesNotContain(PlatformCapabilities.Assistant, candidate.ConfirmedRoles);
            var starts = f.Adapter.StartCount;
            Assert.Equal("dev_review_required", (await Assert.ThrowsAsync<AppLifecycleException>(() => service.RestartAsync(app.Id))).Code);
            Assert.Equal(starts, f.Adapter.StartCount);
        }
        else
        {
            Assert.Contains(CoreAppPermissions.ManageSkills, candidate.GrantedPermissions);
            Assert.Contains(PlatformCapabilities.Assistant, candidate.ConfirmedRoles);
            Assert.Equal("running", (await service.RestartAsync(app.Id)).App!.RuntimeState);
        }
        await ReturnDevelopmentAuthorityToPackage(f, f.RecreateService(), owner, tree);
        app = (await f.Apps.GetAppAsync(app.Id))!;
        Assert.DoesNotContain(CoreAppPermissions.ManageSkills, app.GrantedCorePermissions ?? []);
        Assert.DoesNotContain(PlatformCapabilities.Assistant, app.ConfirmedRoles ?? []);
    }
}
