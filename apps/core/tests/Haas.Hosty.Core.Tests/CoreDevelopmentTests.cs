using System.Diagnostics;
using Haas.Hosty.Core;
using Haas.Hosty.Launch;

namespace Haas.Hosty.Core.Tests;

public sealed class CoreDevelopmentTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "hosty-core-dev-test-" + Guid.NewGuid().ToString("N"));
    private HostyCoreRuntimeConfig Config => new(root, Path.Combine(root, "core", "run"), Path.Combine(root, "core", "run", "control.json"), 7070, "http://localhost:7070", null, "localhost", null, false);
    private string Checkout(string name)
    {
        var path = Path.Combine(root, name);
        var project = Path.Combine(path, "apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj");
        Directory.CreateDirectory(Path.GetDirectoryName(project)!);
        File.WriteAllText(project, "<Project />");
        return path;
    }

    [Fact]
    public void RunnerRotatesConsoleFilesWithoutCore()
    {
        Directory.CreateDirectory(root);
        var path = Path.Combine(root, "web.log");
        using (var writer = new RotatingLogWriter(path))
            for (var index = 0; index < 3500; index++) writer.WriteLine(new string('x', 10000));
        Assert.True(new FileInfo(path).Length < 10 * 1024 * 1024);
        Assert.True(File.Exists(path + ".1"));
        Assert.True(File.Exists(path + ".2"));
        Assert.False(File.Exists(path + ".3"));
    }

    [Fact]
    public async Task StandardClonesTheRemoteDefaultBranchOnceAndReusesAnOfflineDirtyCheckout()
    {
        var remote = Checkout("remote");
        async Task Git(params string[] args)
        {
            var start = new ProcessStartInfo("git") { WorkingDirectory = remote, UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true };
            foreach (var arg in args) start.ArgumentList.Add(arg);
            using var child = Process.Start(start)!;
            var output = child.StandardOutput.ReadToEndAsync(); var error = child.StandardError.ReadToEndAsync();
            await child.WaitForExitAsync(); await output;
            Assert.True(child.ExitCode == 0, await error);
        }
        await Git("init", "--initial-branch=custom-default");
        await Git("add", ".");
        await Git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture");
        var service = new CoreDevelopmentService(Config, new("release", null, null, 4321, DateTimeOffset.UtcNow));
        var project = await service.PrepareSourceAsync(new(null, "initial"), default, remote);
        Assert.Equal("custom-default", (await service.GetAsync()).Branch);
        File.AppendAllText(project, "<!-- operator change -->");
        Directory.Move(remote, remote + "-offline");
        Assert.Equal(project, await service.PrepareSourceAsync(new(null, "initial"), default, remote));
        Assert.Contains("operator change", File.ReadAllText(project));
        Assert.Equal(1, (await service.GetAsync()).ChangedFiles);
    }

    [Fact]
    public async Task SourceChangesArePendingForTheRunningDevInstanceAndRevisionChecked()
    {
        var original = Checkout("original");
        var replacement = Checkout("replacement");
        var identity = new CoreLaunchIdentity("dev", Path.Combine(original, "apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj"), null, 4321, DateTimeOffset.UtcNow);
        var service = new CoreDevelopmentService(Config, identity);
        var saved = await service.SaveAsync(new(replacement, "initial"), default);
        var state = await service.GetAsync();
        Assert.True(state.RestartRequired);
        Assert.Equal(identity.ProjectPath, state.Launch.ProjectPath);
        Assert.Equal(replacement, state.SourcePath);
        await Assert.ThrowsAsync<InvalidOperationException>(() => service.SaveAsync(new(original, "initial"), default));
        await service.SaveAsync(new(original, saved.Revision), default);
        Assert.False((await service.GetAsync()).RestartRequired);
    }

    [Fact]
    public async Task ReleaseSourceEditDoesNotRequireRestartAndExternalFolderIsUntouched()
    {
        var checkout = Checkout("source");
        var service = new CoreDevelopmentService(Config, new("release", null, null, 4321, DateTimeOffset.UtcNow));
        await service.SaveAsync(new(checkout, "initial"), default);
        Assert.False((await service.GetAsync()).RestartRequired);
        Assert.Single(Directory.EnumerateFiles(checkout, "*", SearchOption.AllDirectories));
        var revision = (await service.GetAsync()).Source.Revision;
        await Assert.ThrowsAsync<InvalidOperationException>(() => service.SaveAsync(new("relative", revision), default));
    }

    [Fact]
    public async Task DuplicateOperationReturnsDurableResultEvenAfterTheInstanceChanged()
    {
        var id = Guid.NewGuid().ToString("N");
        var operation = new CoreLaunchOperation(id, "completed", "dev", "/source/Core.csproj", DateTimeOffset.UtcNow);
        CoreLaunchFiles.Write(CoreLaunchFiles.OperationPath(root, id), operation, CoreLaunchJson.Default.CoreLaunchOperation);
        var service = new CoreDevelopmentService(Config, new("release", null, null, 4321, DateTimeOffset.UtcNow));
        Assert.Equal(operation, await service.RestartAsync(new(id, "previous-instance"), default));
        await Assert.ThrowsAsync<InvalidOperationException>(() => service.RestartAsync(new(Guid.NewGuid().ToString("N"), "previous-instance"), default));
        Assert.Throws<ArgumentException>(() => service.GetOperation("../../foreign"));
    }

    [Fact]
    public async Task RestartRequiresTheCurrentSourceRevision()
    {
        var service = new CoreDevelopmentService(Config, new("release", null, null, 4321, DateTimeOffset.UtcNow));
        var state = await service.GetAsync();
        var missing = await Assert.ThrowsAsync<InvalidOperationException>(() => service.RestartAsync(new(Guid.NewGuid().ToString("N"), state.Instance), default));
        Assert.Contains("revision", missing.Message);
        await Assert.ThrowsAsync<InvalidOperationException>(() => service.RestartAsync(new(Guid.NewGuid().ToString("N"), state.Instance, SourceRevision: "stale"), default));
        Assert.False(Directory.Exists(Path.Combine(root, "core", "operations")));
    }

    [Fact]
    public async Task SourceCannotChangeWhileALaunchOwnsTheLease()
    {
        using var lease = CoreLaunchFiles.Lock(root);
        var service = new CoreDevelopmentService(Config);
        await Assert.ThrowsAsync<IOException>(() => service.SaveAsync(new(null, "initial"), default));
    }

    [Fact]
    public async Task RunnerLogsSurviveClosedCorePipesAndCanBeAdoptedThenStopped()
    {
        Directory.CreateDirectory(Path.Combine(root, "logs"));
        var log = Path.Combine(root, "logs", "web.log");
        var start = new ProcessStartInfo("dotnet") { UseShellExecute = false, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
        start.ArgumentList.Add(typeof(HostyCoreApplication).Assembly.Location);
        start.ArgumentList.Add(LocalCommandRunner.Verb);
        start.ArgumentList.Add(log);
        start.ArgumentList.Add(OperatingSystem.IsWindows() ? "for /L %i in (1,1,100) do @(echo alive & ping -n 2 127.0.0.1 >nul)" : "while true; do echo alive; echo diagnostic >&2; sleep 0.1; done");
        using var runner = Process.Start(start)!;
        try
        {
            runner.StandardInput.Close(); runner.StandardOutput.Close(); runner.StandardError.Close();
            var deadline = DateTime.UtcNow.AddSeconds(10);
            while ((!File.Exists(log) || new FileInfo(log).Length == 0) && DateTime.UtcNow < deadline && !runner.HasExited) await Task.Delay(50);
            Assert.False(runner.HasExited);
            var before = new FileInfo(log).Length;
            await Task.Delay(1200);
            Assert.True(new FileInfo(log).Length > before);
            await LocalCommandProcessReclaim.WriteAsync(root, new(runner.Id, runner.StartTime.ToUniversalTime(), "test.app", "web", !OperatingSystem.IsWindows(), root, new Dictionary<string, int> { ["http"] = 23456 }));
            var registry = new LocalCommandProcessRegistry();
            Assert.True(await registry.TryAdoptAsync(root, "test.app", "web", default));
            Assert.Equal(23456, registry.Get("test.app", "web")!.Ports["http"]);
            Assert.True(registry.HasApp("test.app"));
            Assert.True(await LocalCommandProcessReclaim.ReclaimAsync(root, "web"));
            await runner.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
        }
        finally { if (!runner.HasExited) runner.Kill(true); }
    }

    [Fact]
    public async Task ReusedPidIsNotAdoptedOrKilled()
    {
        using var current = Process.GetCurrentProcess();
        await LocalCommandProcessReclaim.WriteAsync(root, new(current.Id, current.StartTime.ToUniversalTime().AddMinutes(-5), "test.app", "web", false));
        var registry = new LocalCommandProcessRegistry();
        await Assert.ThrowsAsync<IOException>(() => registry.TryAdoptAsync(root, "test.app", "web", default));
        Assert.False(current.HasExited);
        Assert.Null(registry.Get("test.app", "web"));
    }

    public void Dispose() { try { Directory.Delete(root, true); } catch (IOException) { } }
}
