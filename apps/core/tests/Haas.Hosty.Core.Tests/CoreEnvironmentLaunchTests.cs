using System.Diagnostics;
using Haas.Hosty.Core;
using Microsoft.Extensions.Logging.Abstractions;

namespace Haas.Hosty.Core.Tests;

public sealed class CoreEnvironmentLaunchTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "hosty child launch " + Guid.NewGuid().ToString("N"));

    [Fact]
    public async Task Start_MissingChildExecutableRetainsStartupLogAndExitCode()
    {
        Directory.CreateDirectory(root);
        var record = Record(Path.Combine(root, "missing child", "hosty-core.exe"));
        var runtime = Runtime();

        var error = await Assert.ThrowsAsync<SandboxException>(() => runtime.StartAsync(record, root, _ => Task.CompletedTask, default));

        Assert.Equal("environment_launch_failed", error.Code);
        Assert.Contains("exit code", error.Message);
        var log = Assert.Single(Directory.GetFiles(Path.Combine(root, "core", "logs"), "environment-*.log"));
        var text = await File.ReadAllTextAsync(log);
        Assert.Contains("[hosty] Starting child Core.", text);
        Assert.Contains("[hosty] Child Core launcher exited before readiness (exit code", text);
        Assert.Contains(log, error.Message);
    }

    [Fact]
    public async Task Start_PortCollisionKeepsItsRetryableErrorAndChildOutput()
    {
        Directory.CreateDirectory(root);
        var executable = Path.Combine(root, OperatingSystem.IsWindows() ? "child.cmd" : "child");
        await File.WriteAllTextAsync(executable, OperatingSystem.IsWindows()
            ? "@echo off\r\necho Hosty Core cannot bind test endpoint 1>&2\r\nexit /b 23\r\n"
            : "#!/bin/sh\nprintf 'Hosty Core cannot bind test endpoint\\n' >&2\nexit 23\n");
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(executable, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);

        var error = await Assert.ThrowsAsync<SandboxException>(() => Runtime().StartAsync(Record(executable), root, _ => Task.CompletedTask, default));

        Assert.Equal("environment_port_collision", error.Code);
        Assert.Contains("exit code 23", error.Message);
        var log = Assert.Single(Directory.GetFiles(Path.Combine(root, "core", "logs"), "environment-*.log"));
        var text = await File.ReadAllTextAsync(log);
        Assert.Contains("Hosty Core cannot bind test endpoint", text);
        Assert.Contains("exit code 23", text);
    }

    [WindowsNativeFact]
    public async Task WindowsLaunch_ExecutesQuotedPathsAndRedirectsBothStreams()
    {
        var directory = Path.Combine(root, "child & output (quoted)");
        Directory.CreateDirectory(directory);
        var executable = Path.Combine(directory, "child program.cmd");
        var log = Path.Combine(directory, "child output.log");
        await File.WriteAllTextAsync(executable, "@echo off\r\necho child-standard-output\r\necho child-standard-error 1>&2\r\nexit /b 17\r\n");
        await File.WriteAllTextAsync(log, "startup-log-marker\n");
        var start = new ProcessStartInfo { WorkingDirectory = directory, UseShellExecute = false, CreateNoWindow = true };
        CoreEnvironmentRuntime.ConfigureWindowsLaunch(start, executable, log);

        var result = await ProcessRunner.RunAsync(start, TimeSpan.FromSeconds(10), outputLimit: 4096);

        Assert.False(result.TimedOut);
        Assert.Equal(17, result.ExitCode);
        Assert.Empty(result.StandardOutput);
        Assert.Empty(result.StandardError);
        var text = await File.ReadAllTextAsync(log);
        Assert.Contains("startup-log-marker", text);
        Assert.Contains("child-standard-output", text);
        Assert.Contains("child-standard-error", text);
    }

    private CoreEnvironmentRuntime Runtime() => new(
        new(root, root, "", 7070, "http://localhost:7070", null, "localhost", null, false),
        new DockerInventory(), new Clients(), NullLogger<CoreEnvironmentRuntime>.Instance);

    private static CoreEnvironmentRecord Record(string executable) => new(Guid.NewGuid().ToString("N"), new("launch-test", null, null),
        new(Guid.NewGuid().ToString(), "Launch regression"), "hash", 7070, 1, "stopped", DateTimeOffset.UtcNow, Executable: executable);

    private sealed class DockerInventory : IDockerCommandRunner
    {
        public Task<DockerCommandResult> RunAsync(IReadOnlyList<string> args, IReadOnlyDictionary<string, string>? environment, CancellationToken ct)
            => Task.FromResult(new DockerCommandResult(0, args[0] == "context"
                ? OperatingSystem.IsWindows() ? "npipe:////./pipe/docker_engine" : "unix:///unused-launch-test.sock"
                : "[]", ""));
    }
    private sealed class Clients : IHttpClientFactory { public HttpClient CreateClient(string name) => new(); }

    public void Dispose() { if (Directory.Exists(root)) Directory.Delete(root, recursive: true); }
}
