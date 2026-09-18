using System.Diagnostics;
using Haas.Hosty.Cli.Commands;
using Haas.Hosty.Cli.Configuration;
using Haas.Hosty.Launch;
using Spectre.Console;

namespace Haas.Hosty.Cli.Tests.Commands;

public sealed class CoreBuildTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "hosty-build-test-" + Guid.NewGuid().ToString("N"));
    private CoreCommand Command(StringWriter output)
        => new(new CommandContext(AnsiConsole.Create(new AnsiConsoleSettings { Ansi = AnsiSupport.No, Out = new AnsiConsoleOutput(output) }), HostyEnvironment.Current(root)));

    [Fact]
    public async Task FailedPreparationDoesNotAttemptToStopTheRunningInstance()
    {
        Directory.CreateDirectory(root);
        var project = Path.Combine(root, "Broken.csproj");
        File.WriteAllText(project, "<Project><Target Name=\"Build\"><Error Text=\"deliberate-compiler-failure\" /></Target></Project>");
        var discovery = Path.Combine(root, "core", "run", "control.json");
        Directory.CreateDirectory(Path.GetDirectoryName(discovery)!);
        const string sentinel = "Must not be opened before the build succeeds";
        File.WriteAllText(discovery, sentinel);
        using var output = new StringWriter();
        Assert.Equal(1, await Command(output).ExecuteAsync(["restart", "--keep-apps", "--project", project]));
        Assert.Equal(sentinel, File.ReadAllText(discovery));
        Assert.Contains("deliberate-compiler-failure", output.ToString());
        Assert.Contains("not stopped", output.ToString());
        Assert.Single(Directory.GetFiles(Path.Combine(root, "core", "builds"), "build.log", SearchOption.AllDirectories));
    }

    [Fact]
    public void LaunchModeIsExplicitRatherThanInheritedFromTheLastSourceSetting()
    {
        using var output = new StringWriter();
        var command = Command(output);
        var release = command.BuildCoreEnvironment(new(null, null, false), CoreCommand.CoreStartTarget.FromExecutable("/release/hosty-core"));
        var dev = command.BuildCoreEnvironment(new("/source/Core.csproj", null, false), new("/built/hosty-core", "/source", [], "/source/Core.csproj", "/build/generation"));
        Assert.Equal("release", release["HOSTY_CORE_LAUNCH_MODE"]);
        Assert.Equal("", release["HOSTY_CORE_PROJECT"]);
        Assert.Equal("dev", dev["HOSTY_CORE_LAUNCH_MODE"]);
        Assert.Equal("/source/Core.csproj", dev["HOSTY_CORE_PROJECT"]);
        Assert.Equal("/build/generation", dev["HOSTY_CORE_GENERATION"]);
    }

    [Fact]
    public void RetentionProtectsActivePreviousFailedAndRunnerReferencedOutputs()
    {
        var builds = Path.Combine(root, "core", "builds");
        string Add(string state, int age)
        {
            var id = Guid.NewGuid().ToString("N");
            var path = Path.Combine(builds, id);
            CoreLaunchFiles.Write(Path.Combine(path, CoreBuildRetention.Marker), new CoreBuildGeneration(id, state, DateTimeOffset.UtcNow.AddMinutes(-age), int.MaxValue, DateTimeOffset.MinValue), CoreLaunchJson.Default.CoreBuildGeneration);
            return path;
        }
        var stale = Add("ready", 10);
        var runner = Add("ready", 9);
        var previous = Add("ready", 2);
        var active = Add("ready", 1);
        var failed = Add("failed", 0);
        var futureFormat = Add("unknown-format", 20);
        var unknown = Path.Combine(builds, "operator-output");
        Directory.CreateDirectory(unknown);
        using var process = Process.GetCurrentProcess();
        var run = Path.Combine(root, "apps", "example", "run"); Directory.CreateDirectory(run);
        File.WriteAllText(Path.Combine(run, "web.json"), System.Text.Json.JsonSerializer.Serialize(new { pid = process.Id, startedAtUtc = process.StartTime.ToUniversalTime(), runnerGeneration = runner }));
        CoreBuildRetention.Cleanup(root);
        Assert.False(Directory.Exists(stale));
        foreach (var path in new[] { runner, previous, active, failed, unknown, futureFormat }) Assert.True(Directory.Exists(path));
    }

    public void Dispose() { if (Directory.Exists(root)) Directory.Delete(root, true); }
}
