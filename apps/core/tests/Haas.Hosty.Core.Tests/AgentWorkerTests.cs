using System.Text.Json;
using System.Text.Json.Nodes;
using Haas.Hosty.Core;
using Microsoft.AspNetCore.Http;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    private sealed class AgentTestDockerRunner(Func<IReadOnlyList<string>, DockerCommandResult> run) : IDockerCommandRunner
    {
        public Task<DockerCommandResult> RunAsync(IReadOnlyList<string> args,
            IReadOnlyDictionary<string, string>? environment = null, CancellationToken cancellationToken = default)
            => Task.FromResult(run(args));
    }

    [Theory]
    [InlineData("missing-lease")]
    [InlineData("foreign-lease")]
    [InlineData("private-app-data")]
    [InlineData("symlink")]
    [InlineData("other-generation")]
    [InlineData("image-changed")]
    [InlineData("foreign-coordinator")]
    [InlineData("stopped-coordinator")]
    [InlineData("daemon-unavailable")]
    [InlineData("environment-budget")]
    [InlineData("wrong-token")]
    [InlineData("unreviewed-sources")]
    [InlineData("unconfirmed-assistant")]
    [InlineData("valid")]
    public async Task AgentWorker_CreateDerivesOwnershipAndRejectsUnleasedOrUnscopedMounts(string scenario)
    {
        var f = await LifecycleFixture.CreateAsync();
        try
        {
            var repository = new DirectoryInfo(AppContext.BaseDirectory);
            while (repository is not null && !File.Exists(Path.Combine(repository.FullName, "Directory.Build.props"))) repository = repository.Parent;
            var document = JsonNode.Parse(await File.ReadAllTextAsync(Path.Combine(repository!.FullName, "apps/harness/manifest.json")))!.AsObject();
            document.Remove("source");
            var manifestFile = Path.Combine(f.Root, "harness.json");
            await File.WriteAllTextAsync(manifestFile, document.ToJsonString());
            await f.Service.InstallAsync(new(manifestFile, "docker"));
            var app = (await f.Apps.GetAppAsync("hosty.harness"))!;
            var config = new HostyCoreRuntimeConfig(f.Root, f.Root + "/run", f.Root + "/control.json", 3001,
                "http://127.0.0.1:3001", null, "127.0.0.1", null, false, InstanceId: "worker-test");
            var workerPaths = f.Paths;
            if (scenario == "environment-budget")
            {
                var parent = new CoreEnvironmentStore(f.Paths);
                var id = Guid.NewGuid().ToString("N");
                Directory.CreateDirectory(Path.Combine(parent.Root(id), "core"));
                await File.WriteAllTextAsync(CoreInstanceId.BuildPath(parent.Root(id)), id);
                await parent.WriteAsync(new(id, new("admin"), new(Guid.NewGuid().ToString(), "Worker budget"),
                    "hash", 7071, 1, "running", DateTimeOffset.UtcNow), default);
                config = config with { DataRoot = parent.Root(id), InstanceId = id };
                workerPaths = CoreDataPaths.FromConfig(config);
            }
            var imageId = "sha256:" + new string('a', 64);
            var commands = new List<string[]>();
            var runner = new AgentTestDockerRunner(args =>
            {
                commands.Add(args.ToArray());
                if (scenario == "daemon-unavailable" && args[0] == "info") return new(1, "", "Daemon unavailable.");
                return new(0, args[0] switch
                {
                    "context" => "unix:///test/docker.sock",
                    "info" => "linux",
                    "ps" when scenario == "environment-budget" && args.Contains("label=hosty.instance=" + config.InstanceId) => "coordinator",
                    "inspect" when scenario == "environment-budget" && args[1] == "coordinator" => JsonSerializer.Serialize(new[] { new {
                        Config = new { Labels = new Dictionary<string, string> { ["hosty.app.id"] = app.Id, ["hosty.app.service"] = "api" } },
                        HostConfig = new { Memory = 3221225472L, NanoCpus = 1000000000L, PidsLimit = 256 }
                    } }),
                    "ps" when scenario == "other-generation" && args.Any(a => a.StartsWith("label=", StringComparison.Ordinal)) => "existing-generation",
                    "image" => JsonSerializer.Serialize(new[] { new { Id = scenario == "image-changed" ? "sha256:changed" : imageId } }),
                    "inspect" => JsonSerializer.Serialize(new[] { new {
                        Config = new { Labels = new Dictionary<string, string> { ["hosty.instance"] = config.InstanceId, ["hosty.app.id"] = scenario == "foreign-coordinator" ? "another.app" : app.Id } },
                        State = new { Running = scenario != "stopped-coordinator" }
                    } }),
                    _ => ""
                }, "");
            });
            var tokens = new AppServiceTokenService(new AppServiceSigningKey("worker-test-signing"u8.ToArray()));
            var service = new AgentWorkerService(workerPaths, config, f.Apps, f.Manifests, tokens, runner);
            if (scenario is "wrong-token" or "unreviewed-sources" or "unconfirmed-assistant")
            {
                if (scenario == "unreviewed-sources") app = app with { GrantedCorePermissions = [] };
                if (scenario == "unconfirmed-assistant") app = app with { ConfirmedRoles = [] };
                await f.Apps.UpsertAppAsync(app);
                var requestContext = new DefaultHttpContext();
                requestContext.Request.Headers.Authorization = "Bearer " + tokens.CreateToken(scenario == "wrong-token" ? "another.app" : app.Id);
                await Assert.ThrowsAsync<AppIdentityException>(() => service.AuthenticateAsync(app.Id, requestContext.Request, default));
                Assert.Empty(commands);
                return;
            }
            var generation = Guid.NewGuid().ToString("D");
            var lease = new DevelopmentWorkerLease(new(app.Id, app.InstalledAt, "admin", "test-session"), generation, true);
            if (scenario == "foreign-lease") lease = lease with { Owner = lease.Owner with { AppId = "another.app" } };
            if (scenario != "missing-lease")
                await JsonStorage.WriteAsync(Path.Combine(workerPaths.CoreRoot, "development", "worker-leases", generation + ".json"), lease);
            var appRoot = Path.Combine(MountPathPolicy.ResolveRealPath(workerPaths.DataRoot), "apps", app.Id);
            var cwd = Path.Combine(appRoot, "cache", "sessions", "test", "workspace");
            foreach (var path in new[] { cwd, Path.Combine(appRoot, "cache", "agent-worker", generation, "home"),
                Path.Combine(appRoot, "cache", "agent-worker", "cache"), Path.Combine(workerPaths.CoreRoot, "development", "trees"),
                Path.Combine(workerPaths.CoreRoot, "development", "repositories"), Path.Combine(appRoot, "data", "private") })
                Directory.CreateDirectory(path);
            if (scenario == "private-app-data") cwd = Path.Combine(appRoot, "data", "private");
            if (scenario == "symlink")
            {
                var redirected = Path.Combine(appRoot, "cache", "sessions", "redirected");
                Directory.CreateSymbolicLink(redirected, Path.Combine(appRoot, "data", "private"));
                cwd = redirected;
            }
            var request = new AgentWorkerRequest(generation, imageId, [new(cwd)]);
            if (scenario == "valid")
            {
                await service.ExecuteAsync(app, "create", request, default);
                var create = Assert.Single(commands, c => c[0] == "create");
                Assert.Contains("container:" + DockerRuntimeAdapter.BuildContainerName(config.InstanceId, app.Id, "api"), create);
                Assert.Contains("--read-only", create);
                Assert.Contains("--cap-drop", create);
                Assert.Contains("4294967296", create);
                Assert.Contains(create, value => value.EndsWith("/repositories,readonly", StringComparison.Ordinal));
                Assert.DoesNotContain(create, value => value.Contains("docker.sock", StringComparison.Ordinal));
                Assert.Equal(imageId, create[^1]);
            }
            else
            {
                if (scenario == "environment-budget")
                    Assert.Equal("environment_application_capacity", (await Assert.ThrowsAsync<SandboxException>(
                        () => service.ExecuteAsync(app, "create", request, default))).Code);
                else await Assert.ThrowsAsync<AppLifecycleException>(() => service.ExecuteAsync(app, "create", request, default));
                Assert.DoesNotContain(commands, c => c[0] == "create");
            }
        }
        finally { Directory.Delete(f.Root, recursive: true); }
    }

    [Theory]
    [InlineData("HOSTY_APP_SERVICE_TOKEN", false)]
    [InlineData("SSH_AUTH_SOCK", false)]
    [InlineData("DOCKER_HOST", false)]
    [InlineData("HOSTY_MCP_SESSION_TOKEN", true)]
    [InlineData("CODEX_HOME", true)]
    public void AgentWorker_ExecKeepsCoordinatorCredentialsOutOfAgentEnvironment(string key, bool allowed)
        => Assert.Equal(allowed, AgentWorkerService.AllowedEnvironment(key));
    [Theory]
    [InlineData("added")]
    [InlineData("removed")]
    [InlineData("image")]
    public async Task AgentWorker_UpdateReviewsWorkerContractAndPreservesSelectedLocal(string change)
    {
        var f = await LifecycleFixture.CreateAsync();
        try
        {
            var repository = new DirectoryInfo(AppContext.BaseDirectory);
            while (repository is not null && !File.Exists(Path.Combine(repository.FullName, "Directory.Build.props"))) repository = repository.Parent;
            var document = JsonNode.Parse(await File.ReadAllTextAsync(Path.Combine(repository!.FullName, "apps/harness/manifest.json")))!.AsObject();
            document.Remove("source");
            var worker = document["agentWorker"]!.DeepClone();
            if (change == "added") document.Remove("agentWorker");
            var installed = Path.Combine(f.Root, "installed-harness.json");
            await File.WriteAllTextAsync(installed, document.ToJsonString());
            await f.Service.InstallAsync(new(installed, "local"));
            if (change == "added") document["agentWorker"] = worker;
            if (change == "removed") document.Remove("agentWorker");
            if (change == "image") document["agentWorker"]!["image"] = "ghcr.io/alex-de-haas/hosty-agent-worker:0.62.1";
            var candidate = Path.Combine(f.Root, "candidate-harness.json");
            await File.WriteAllTextAsync(candidate, document.ToJsonString());
            var plan = await f.Service.CreateUpdatePlanAsync("hosty.harness", new(candidate));
            Assert.Equal("local", plan.TargetRuntime);
            Assert.Contains(plan.Changes, value => value.StartsWith("agentWorker:", StringComparison.Ordinal));
            Assert.True(plan.RequiresReview);
        }
        finally { Directory.Delete(f.Root, recursive: true); }
    }

}
