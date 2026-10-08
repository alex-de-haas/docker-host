namespace Haas.Hosty.Core.Tests;

public sealed partial class RuntimeAppSupervisorServiceTests
{
    [Fact]
    public async Task ConfigurationReadiness_SupervisorDoesNotRetryAnIncompleteCrash()
    {
        var fixture = CreateFixture(_ => throw new HttpRequestException("no remote fetch expected"));
        var path = Path.Combine(root, "incomplete-app.json");
        await File.WriteAllTextAsync(path, CreateShellManifest("1.0.0", "hosty-shell", "local", "never")
            .Replace("\"capabilities\":", "\"settings\": [{ \"key\": \"REQUIRED_TOKEN\", \"type\": \"string\", \"secret\": true, \"required\": true }], \"capabilities\":", StringComparison.Ordinal));
        await fixture.Lifecycle.InstallAsync(new AppInstallRequest(path));
        var supervisor = CreateSupervisor(fixture, CreateConfig(fixture.Paths, shellAutostart: true), CreateDistribution());
        var observation = new AppHealthObservation("hosty.shell", "stopped", new RuntimeRestartPolicy("always", 3, 0));

        foreach (var attempt in Enumerable.Range(0, 5))
            await supervisor.ApplyRestartPolicyAsync(observation, CancellationToken.None);

        var app = (await fixture.Apps.GetAppAsync("hosty.shell"))!;
        Assert.Equal("installed", app.OperationStatus);
        Assert.Equal("stopped", app.RuntimeState);
        Assert.Null(app.LastError);
        Assert.True(app.Autostart);
    }
}
