using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using Haas.Hosty.Core;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class SessionRetentionHttpTests
{
    private const string Route = "/api/internal/apps/hosty.harness/sessions/retained/retention";
    [Fact]
    public async Task BackgroundRetentionScopesOwnershipAndRequiresReviewedCleanupWithFreshCompletion()
    {
        var runtime = new CleanupRuntime();
        await using var host = await CoreHttpHarness.StartAsync(configure: services => services.AddSingleton<ICoreEnvironmentRuntime>(runtime));
        var services = host.Services;
        var now = services.GetRequiredService<IClock>().UtcNow;
        var users = services.GetRequiredService<UserDirectoryStore>();
        await users.WriteAsync(new(1, [new("admin", "admin@example.test", "Admin", "host.admin", false, now, now)], [], [], []));
        var apps = services.GetRequiredService<AppRegistryStore>();
        var app = new AppRecord("hosty.harness", "Harness", null, "1.0.0", "runtime", true, "installed", null, null,
            "local", "installed", "running", null, null, [], new Dictionary<string, AppSettingValue>(), [], [], [], now, now)
            { ConfirmedRoles = ["assistant"], GrantedCorePermissions = [CoreAppPermissions.Sources],
              Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>> { ["assistant"] = [new("default", null, "/assistant")] } };
        await apps.UpsertAppAsync(app);
        using var client = host.CreateClient();
        async Task<HttpResponseMessage> Read(string user = "admin", WorkspaceWorkflowCommand? command = null, string route = Route)
            => await client.PostAsJsonAsync(route, new SessionRetentionRequest(user, command), CoreJson.TypeInfo<SessionRetentionRequest>());
        Assert.Equal(HttpStatusCode.Unauthorized, (await Read()).StatusCode);
        client.DefaultRequestHeaders.Authorization = new("Bearer", services.GetRequiredService<AppServiceTokenService>().CreateToken(app.Id));
        Assert.Equal(HttpStatusCode.Forbidden, (await Read("missing-owner")).StatusCode);
        Assert.Equal("chat", (await (await Read()).Content.ReadFromJsonAsync(CoreJson.TypeInfo<SessionRetentionSnapshot>()))!.Kind);
        var paths = services.GetRequiredService<CoreDataPaths>();
        var origin = Path.Combine(paths.CoreRoot, "retention-source"); Directory.CreateDirectory(origin);
        await Git(origin, "init", "--initial-branch=main");
        await File.WriteAllTextAsync(Path.Combine(origin, "README.md"), "source");
        await Git(origin, "add", ".");
        await Git(origin, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "initial");
        await apps.UpsertAppAsync(app with { Id = "source.app", SourceState = new("git", origin, "main", null, origin, null, now) });
        var owner = new WorkspaceOwner(app.Id, app.InstalledAt, "admin", "retained");
        var workspaces = services.GetRequiredService<DevelopmentWorkspaceService>();
        var tree = await workspaces.PrepareAsync(owner, new(Guid.NewGuid().ToString(), "retained", "source.app", "/assistant?session=retained"), default);
        var snapshot = (await (await Read()).Content.ReadFromJsonAsync(CoreJson.TypeInfo<SessionRetentionSnapshot>()))!;
        Assert.Equal("workspace", snapshot.Kind);
        Assert.Equal("in-progress", snapshot.Workflow!.State);
        var other = (await (await Read(route: Route.Replace("/retained/", "/other-session/"))).Content.ReadFromJsonAsync(CoreJson.TypeInfo<SessionRetentionSnapshot>()))!;
        Assert.Equal("chat", other.Kind);
        var delete = new WorkspaceWorkflowCommand(Guid.NewGuid().ToString(), 0);
        Assert.Equal(HttpStatusCode.Forbidden, (await Read(command: delete)).StatusCode);
        app = app with { GrantedCorePermissions = [CoreAppPermissions.Sources, CoreAppPermissions.WorkspacesCleanup, CoreAppPermissions.CoreEnvironmentsManage] };
        await apps.UpsertAppAsync(app);
        Assert.Equal(HttpStatusCode.Conflict, (await Read(command: delete)).StatusCode);
        Assert.True(Directory.Exists(tree.Path));
        await apps.UpsertAppAsync(app with { InstalledAt = now.AddSeconds(1) });
        Assert.Equal(HttpStatusCode.Conflict, (await Read()).StatusCode);
        await apps.UpsertAppAsync(app);
        var complete = await workspaces.ChangeWorkflowAsync(owner, "admin", "complete", new(Guid.NewGuid().ToString(), 0), new Dictionary<string, string>(), default);
        delete = new(Guid.NewGuid().ToString(), complete.Revision);
        await File.WriteAllTextAsync(Path.Combine(tree.Path, "README.md"), "unfinished edit");
        Assert.Equal(HttpStatusCode.Conflict, (await Read(command: delete)).StatusCode);
        Assert.True(Directory.Exists(tree.Path));
        await Git(tree.Path, "restore", "README.md");
        var workflow = await workspaces.WorkflowAsync(owner, default);
        complete = await workspaces.ChangeWorkflowAsync(owner, "admin", "complete", new(Guid.NewGuid().ToString(), workflow.Revision), new Dictionary<string, string>(), default);
        delete = new(Guid.NewGuid().ToString(), complete.Revision);
        var environments = services.GetRequiredService<CoreEnvironmentService>();
        var actor = new SandboxActor(owner.UserId, owner.AppId, owner.Installation);
        var stale = await environments.CreateAsync(actor, new(Guid.NewGuid().ToString(), "Unaccepted cleanup", Context: new(WorkspaceId: tree.WorkspaceId)), default, operatorApproved: true);
        var accepted = await environments.CreateAsync(actor, new(Guid.NewGuid().ToString(), "Interrupted cleanup", Context: new(WorkspaceId: tree.WorkspaceId)), default, operatorApproved: true);
        var retained = (await (await Read()).Content.ReadFromJsonAsync(CoreJson.TypeInfo<SessionRetentionSnapshot>()))!;
        Assert.True(retained.IndependentEnvironments); Assert.False(retained.ResourcesFinished);
        Assert.Equal(stale.State, (await environments.ReadAsync(actor, stale.Id, default)).State);
        Assert.Equal(accepted.State, (await environments.ReadAsync(actor, accepted.Id, default)).State);
        var staleRequest = Guid.NewGuid().ToString(); var acceptedRequest = Guid.NewGuid().ToString();
        await environments.CommandAsync(new(owner.UserId), stale.Id, "stop", new(Guid.NewGuid().ToString(), stale.Revision), default);
        runtime.FailOnce = accepted.Id;
        var failed = await environments.CommandAsync(new(owner.UserId), accepted.Id, "finish", new(acceptedRequest, accepted.Revision), default);
        Assert.Equal("cleanup-failed", failed.State);
        var jobPath = Path.Combine(paths.CoreRoot, "development", "cleanup", delete.RequestId + ".json");
        await JsonStorage.WriteAsync(jobPath, new WorkspaceCleanupJob(tree.WorkspaceId, owner.UserId, delete,
            [new(stale.Id, "core", staleRequest, stale.Revision), new(accepted.Id, "core", acceptedRequest, accepted.Revision)]));
        var deleted = await Read(command: delete);
        Assert.Equal(HttpStatusCode.OK, deleted.StatusCode);
        Assert.Equal("deleted", (await deleted.Content.ReadFromJsonAsync(CoreJson.TypeInfo<SessionRetentionSnapshot>()))!.Workflow!.State);
        Assert.False(Directory.Exists(tree.Path));
        Assert.False(Directory.Exists(stale.DataRoot)); Assert.False(Directory.Exists(accepted.DataRoot));
        Assert.False(File.Exists(jobPath));
        Assert.Empty((await workspaces.ListAsync(owner, true, default)).Workspaces);
        Assert.Null(await workspaces.ReadDeletionAsync(tree.WorkspaceId, default));
        var staleResult = await environments.ReadAsync(new(owner.UserId), stale.Id, default);
        Assert.DoesNotContain(staleResult.Operations, o => o.Id == CoreEnvironmentService.RequestId(staleRequest));
        Assert.Contains(staleResult.Operations, o => o.Kind == "finish" && o.State == "succeeded");
        var acceptedResult = await environments.ReadAsync(new(owner.UserId), accepted.Id, default);
        Assert.Single(acceptedResult.Operations, o => o.Id == CoreEnvironmentService.RequestId(acceptedRequest));
        Assert.True((await (await Read()).Content.ReadFromJsonAsync(CoreJson.TypeInfo<SessionRetentionSnapshot>()))!.WorkspaceAbsent);
        Assert.Equal(HttpStatusCode.OK, (await Read(command: delete)).StatusCode);
        await apps.UpsertAppAsync(app with { InstalledAt = now.AddSeconds(1) });
        Assert.Equal("chat", (await (await Read()).Content.ReadFromJsonAsync(CoreJson.TypeInfo<SessionRetentionSnapshot>()))!.Kind);
        await apps.UpsertAppAsync(app);
        // Startup recovery migrates legacy terminal records without touching active source.
        var legacyOwner = owner with { SessionId = "legacy-deleted" };
        var legacy = await workspaces.PrepareAsync(legacyOwner, new(Guid.NewGuid().ToString(), legacyOwner.SessionId, "source.app", "/assistant?session=legacy-deleted"), default);
        await workspaces.ChangeWorkflowAsync(legacyOwner, owner.UserId, "complete", new(Guid.NewGuid().ToString(), 0), new Dictionary<string, string>(), default);
        await workspaces.ChangeWorkflowAsync(legacyOwner, owner.UserId, "delete", new(Guid.NewGuid().ToString(), 1), new Dictionary<string, string>(), default);
        var activeOwner = owner with { SessionId = "still-active" };
        var active = await workspaces.PrepareAsync(activeOwner, new(Guid.NewGuid().ToString(), activeOwner.SessionId, "source.app", "/assistant?session=still-active"), default);
        using (var recovery = new WorkspaceDeletionRecovery(services.GetRequiredService<WorkspaceCleanupService>(),
            Microsoft.Extensions.Logging.Abstractions.NullLogger<WorkspaceDeletionRecovery>.Instance))
        {
            await recovery.StartAsync(default);
            await recovery.ExecuteTask!;
        }
        Assert.Empty((await workspaces.ListAsync(legacyOwner, true, default)).Workspaces);
        Assert.False(Directory.Exists(legacy.Path));
        Assert.True(Directory.Exists(active.Path));
        Assert.Single((await workspaces.ListAsync(activeOwner, true, default)).Workspaces);
        await users.UpdateAsync(state => state with { Users = state.Users.Select(u => u with { Disabled = true }).ToArray() });
        Assert.Equal(HttpStatusCode.Forbidden, (await Read()).StatusCode);
    }
    private sealed class CleanupRuntime : ICoreEnvironmentRuntime
    {
        public string? FailOnce;
        public Task<string> PrepareAsync(CoreEnvironmentRecord record, string root, CancellationToken ct) => throw new NotSupportedException();
        public Task<CoreEnvironmentProcess?> ObserveAsync(CoreEnvironmentRecord record, string root, CancellationToken ct) => Task.FromResult<CoreEnvironmentProcess?>(null);
        public Task StartAsync(CoreEnvironmentRecord record, string root, Func<CoreEnvironmentProcess, Task> saveProcess, CancellationToken ct) => throw new NotSupportedException();
        public Task StopAsync(CoreEnvironmentRecord record, string root, bool remove, CancellationToken ct)
        {
            if (FailOnce == record.Id) { FailOnce = null; throw new IOException("Interrupted Finish"); }
            return Task.CompletedTask;
        }
    }
    private static async Task Git(string dir, params string[] args)
    {
        var start = new ProcessStartInfo("git") { WorkingDirectory = dir, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var arg in args) start.ArgumentList.Add(arg);
        using var process = Process.Start(start)!;
        var stdout = process.StandardOutput.ReadToEndAsync(); var stderr = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync(); await stdout; Assert.True(process.ExitCode == 0, await stderr);
    }
}
