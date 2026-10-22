using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class DockerRuntimeAdapterTests
{
    [Fact]
    public async Task NonAgentProcessor_UsesNormalLifecycleWithScopedStorageAndNoCoreCredentials()
    {
        var root = Directory.CreateTempSubdirectory("hosty-service-fixture-").FullName;
        try
        {
            var baseline = CreateMultiServiceDockerContext("web", "processor");
            var web = baseline.Manifest.Services[0] with { Injection = new() { Settings = ["PUBLIC_SETTING"] } };
            var processor = baseline.Manifest.Services[1] with
            {
                Injection = new() { AppServiceToken = false, AppIdentityToken = false, Settings = [] },
            };
            var manifest = new RuntimeAppManifest
            {
                Data = new() { Enabled = true, Targets = [
                    new() { Runtime = "docker", Service = "web", ContainerPath = "/web" },
                    new() { Runtime = "docker", Service = "processor", SubPath = "processor", ContainerPath = "/control/state" },
                    new() { Runtime = "docker", Service = "processor", SubPath = "auth", ContainerPath = "/control/auth", Environment = "PROCESSOR_AUTH", Mode = "ro" },
                ] },
            };
            var context = baseline with
            {
                AppRoot = root, AppDataPath = Path.Combine(root, "data"), AppCachePath = Path.Combine(root, "cache"),
                App = baseline.App with { Settings = new Dictionary<string, AppSettingValue>
                {
                    ["PUBLIC_SETTING"] = new("PUBLIC_SETTING", "string", "public-value", false),
                    ["PRIVATE_SETTING"] = new("PRIVATE_SETTING", "string", "private-value", true),
                } },
                Manifest = baseline.Manifest with { Manifest = manifest, Services = [web, processor] },
            };
            var runner = new FakeDockerCommandRunner();
            var adapter = CreateAdapter(runner);
            await adapter.StartAsync(context);
            var commands = runner.Commands.Where(command => command[0] == "run").ToArray();
            Assert.Equal(2, commands.Length);
            var webRun = Assert.Single(commands, command => command.Contains("HOSTY_APP_SERVICE_KEY=web"));
            var processorRun = Assert.Single(commands, command => command.Contains("HOSTY_APP_SERVICE_KEY=processor"));
            Assert.Contains("HOSTY_APP_SERVICE_TOKEN", webRun);
            Assert.Contains("PUBLIC_SETTING", webRun);
            Assert.Equal("public-value", runner.Environments[runner.Commands.IndexOf(webRun)]!["PUBLIC_SETTING"]);
            Assert.DoesNotContain("PRIVATE_SETTING", webRun);
            Assert.DoesNotContain(processorRun, value => value.StartsWith("HOSTY_APP_SERVICE_TOKEN") || value.StartsWith("HOSTY_APP_IDENTITY_TOKEN") || value.Contains("private-value") || value.Contains("public-value"));
            Assert.Contains(MountPathPolicy.ResolveRealPath(Path.Combine(root, "data", "processor")) + ":/control/state:rw", processorRun);
            Assert.Contains(MountPathPolicy.ResolveRealPath(Path.Combine(root, "data", "auth")) + ":/control/auth:ro", processorRun);
            Assert.DoesNotContain(processorRun, value => value.EndsWith(":/web:rw"));
            await adapter.StopAsync(context);
            Assert.Equal(2, runner.Commands.Count(command => command[0] == "stop"));
        }
        finally { Directory.Delete(root, true); }
    }
    [Theory]
    [InlineData("none")]
    [InlineData("identity")]
    [InlineData("mount")]
    [InlineData("fingerprint")]
    public async Task TokenlessServiceAdoption_RequiresItsDeclaredServiceContract(string changed)
    {
        var digest = "sha256:" + new string('a', 64);
        var baseline = CreateDockerContext(CreateDockerAppRecord("pinned", LockMap(digest)));
        var service = baseline.Manifest.Services[0] with { Injection = new() { AppServiceToken = false, AppIdentityToken = false, Settings = [] } };
        var context = baseline with { Manifest = baseline.Manifest with { Services = [service] } };
        var first = new FakeDockerCommandRunner();
        await CreateAdapter(first).StartAsync(context);
        var fingerprint = first.Find("run")!.Single(value => value.StartsWith("hosty.service.configuration=", StringComparison.Ordinal)).Split('=')[1];
        var inspection = System.Text.Json.JsonSerializer.Serialize(new[] { new
        {
            Config = new { Labels = new Dictionary<string,string> { ["hosty.app.service"] = "app", ["hosty.service.configuration"] = changed == "fingerprint" ? "changed" : fingerprint },
                Env = changed == "identity" ? new[] { "HOSTY_APP_IDENTITY_TOKEN=unexpected" } : Array.Empty<string>() },
            Mounts = changed == "mount" ? new[] { new { Type = "bind", Source = "/unexpected", Destination = "/unexpected", RW = true } } : [],
        } });
        var adopted = new FakeDockerCommandRunner(args => args is ["inspect", "--format", var fmt, ..] && fmt.Contains("State.Running", StringComparison.Ordinal)
            ? new DockerCommandResult(0, $"true::com.example.app::::ghcr.io/example/app@{digest}::PATH=/usr/bin", "")
            : args is ["inspect", var name] && name.StartsWith("hosty-", StringComparison.Ordinal)
                ? new DockerCommandResult(0, inspection, "") : new DockerCommandResult(0, "", ""));
        await CreateAdapter(adopted).StartAsync(context);
        Assert.Equal(changed != "none", adopted.Commands.Any(command => command[0] == "run"));
    }

}
