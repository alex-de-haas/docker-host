using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using Haas.Hosty.Cli;
using Haas.Hosty.Cli.Commands;
using Haas.Hosty.Launch;
using Spectre.Console;

namespace Haas.Hosty.Cli.Tests.Commands;

public sealed class WorkspaceActivationCapabilityTests : IAsyncLifetime
{
    private readonly string root = Directory.CreateTempSubdirectory("hosty-workspace-capability-").FullName;
    private string Project => Path.Combine(root, "source", "Core.csproj");
    private string Output => Path.Combine(root, "tool");
    private string Executable => Path.Combine(Output, OperatingSystem.IsWindows() ? "hosty-core.exe" : "hosty-core");
    private string Behavior => Path.Combine(Output, "behavior.txt");

    public async Task InitializeAsync()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Project)!);
        await File.WriteAllTextAsync(Project, """
            <Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework>
            <OutputType>Exe</OutputType><AssemblyName>hosty-core</AssemblyName><ImplicitUsings>enable</ImplicitUsings>
            <Nullable>enable</Nullable></PropertyGroup></Project>
            """);
        await File.WriteAllTextAsync(Path.Combine(Path.GetDirectoryName(Project)!, "Program.cs"), """
            var behaviorFile = Path.Combine(AppContext.BaseDirectory, "behavior.txt");
            var behavior = File.Exists(behaviorFile) ? File.ReadAllText(behaviorFile).Trim() : "old";
            if (args is not ["--workspace-activation-contract"] || !File.Exists(Environment.GetEnvironmentVariable("HOSTY_DATA_ROOT")) ||
                Environment.GetEnvironmentVariable("HOSTY_CORE_PORT") != "65536") return 3;
            if (behavior == "hang") { await Task.Delay(60000); return 4; }
            if (behavior == "unknown") return 2;
            Console.WriteLine(behavior == "valid" ? "workspace-activation.2" : "workspace-activation.1");
            return 0;
            """);
        var start = new ProcessStartInfo("dotnet") { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var arg in new[] { "build", Project, "--output", Output, "--nologo" }) start.ArgumentList.Add(arg);
        using var process = Process.Start(start)!;
        var output = process.StandardOutput.ReadToEndAsync(); var error = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        Assert.True(process.ExitCode == 0, await output + await error);
    }

    [Fact]
    public async Task SupportingBinary_AnswersBeforeConfigurationWithoutUsingRealDataRoot()
    {
        await File.WriteAllTextAsync(Behavior, "valid");
        await WorkspaceActivationCapability.RequireAsync(Executable);
        Assert.True(File.Exists(Executable));
    }

    [Theory]
    [InlineData("unknown")]
    [InlineData("old")]
    public async Task UnsupportedBinary_RefusesWithActionableReason(string behavior)
    {
        await File.WriteAllTextAsync(Behavior, behavior);
        var error = await Assert.ThrowsAsync<WorkspaceActivationCompatibilityException>(() => WorkspaceActivationCapability.RequireAsync(Executable));
        Assert.Contains("Update this workspace", error.Message);
        Assert.Contains("did not stop Core or applications", error.Message);
    }

    [Fact]
    public async Task MissingBinary_RefusesWithoutStartingAnything()
    {
        var error = await Assert.ThrowsAsync<WorkspaceActivationCompatibilityException>(() => WorkspaceActivationCapability.RequireAsync(Path.Combine(root, "missing")));
        Assert.Contains("unavailable", error.Message);
    }

    [Fact]
    public async Task UnresponsiveProbe_IsBoundedAndItsProcessIsStopped()
    {
        await File.WriteAllTextAsync(Behavior, "hang");
        var clock = Stopwatch.StartNew();
        var error = await Assert.ThrowsAsync<WorkspaceActivationCompatibilityException>(() => WorkspaceActivationCapability.RequireAsync(Executable, timeout: TimeSpan.FromMilliseconds(200)));
        Assert.Contains("timed out", error.Message);
        Assert.True(clock.Elapsed < TimeSpan.FromSeconds(10));
    }

    [Fact]
    public async Task OrdinaryWorkspaceRestart_RejectsOldCandidateBeforeStopOrReceiptAdmission()
    {
        var dataRoot = Path.Combine(root, "instance");
        var generation = Path.Combine(dataRoot, "core", "builds", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(generation);
        var oldExecutable = Path.Combine(generation, "hosty-core");
        await File.WriteAllTextAsync(oldExecutable, "existing generation");
        using var current = Process.GetCurrentProcess();
        var launch = new CoreLaunchIdentity("dev", Project, generation, current.Id, current.StartTime.ToUniversalTime());
        var activationId = Guid.NewGuid().ToString("D");
        WorkspaceRuntimeFiles.Save(dataRoot, new(activationId, "workspace", "user", "fingerprint", "instance", "revision", "tree", Project,
            new("release", null, null, 5, DateTimeOffset.UtcNow.AddDays(-1)), [], "active", oldExecutable, generation,
            ActivatedCore: launch, CoreReserved: true));
        using var server = new CoreStatusServer(dataRoot, launch);
        var run = Path.Combine(dataRoot, "core", "run"); Directory.CreateDirectory(run);
        await File.WriteAllTextAsync(Path.Combine(run, "control.json"), JsonSerializer.Serialize(new { controlBaseUrl = server.Endpoint + "/control/v1",
            requiredHeaders = new Dictionary<string, string> { ["X-Test-Control"] = "test" }, processId = current.Id, nonce = "test" }));
        var text = new StringWriter();
        var console = AnsiConsole.Create(new AnsiConsoleSettings { Out = new AnsiConsoleOutput(text), Interactive = InteractionSupport.No });
        var result = await CommandLine.RunAsync(["--data-root", dataRoot, "core", "restart", "--keep-apps", "--project", Project], console);
        Assert.Equal(1, result);
        Assert.Contains("does not support the workspace handover contract", text.ToString());
        Assert.Equal(0, server.Stops);
        Assert.Empty(WorkspaceCoreLaunchContinuation.List(dataRoot));
        Assert.Equal(launch, WorkspaceRuntimeFiles.Read(dataRoot, activationId).ActivatedCore);
    }

    [Fact]
    public void HelperReceipt_ExposesOnlyFixedCompatibilityReasonAndKeepsOtherFailuresGeneric()
    {
        var compatibility = new WorkspaceActivationCompatibilityException(WorkspaceActivationCompatibilityFailure.Unsupported);
        Assert.Equal(compatibility.Message, CoreCommand.WorkspaceHelperError(compatibility));
        Assert.Contains("Update this workspace", CoreCommand.WorkspaceHelperError(compatibility));
        var failure = CoreCommand.WorkspaceHelperError(new IOException("private diagnostic output"));
        Assert.DoesNotContain("private diagnostic", failure);
        Assert.Contains("Inspect the retained phase", failure);
    }

    [Fact]
    public async Task AdministratorAdoption_StaleInstanceReturnsFriendlyFailureWithoutMutation()
    {
        var dataRoot = Path.Combine(root, "adoption-instance");
        using var current = Process.GetCurrentProcess();
        var launch = new CoreLaunchIdentity("dev", Project, Path.Combine(dataRoot, "generation"), current.Id, current.StartTime.ToUniversalTime());
        using var server = new CoreStatusServer(dataRoot, launch);
        var run = Path.Combine(dataRoot, "core", "run"); Directory.CreateDirectory(run);
        await File.WriteAllTextAsync(Path.Combine(run, "control.json"), JsonSerializer.Serialize(new { controlBaseUrl = server.Endpoint + "/control/v1",
            requiredHeaders = new Dictionary<string, string> { ["X-Test-Control"] = "test" }, processId = current.Id, nonce = "test" }));
        var text = new StringWriter();
        var console = AnsiConsole.Create(new AnsiConsoleSettings { Out = new AnsiConsoleOutput(text), Interactive = InteractionSupport.No });
        var result = await CommandLine.RunAsync(["--data-root", dataRoot, "core", "adopt-workspace", Guid.NewGuid().ToString("D"),
            "--instance", "stale-instance", "--generation", launch.GenerationPath!], console);
        Assert.Equal(1, result);
        Assert.Contains("Unable to adopt workspace", text.ToString());
        Assert.Contains("does not exactly match", text.ToString());
        Assert.DoesNotContain("Stack", text.ToString());
        Assert.Equal(0, server.Stops);
        Assert.Empty(WorkspaceCoreLaunchContinuation.List(dataRoot));
    }

    public Task DisposeAsync() { Directory.Delete(root, true); return Task.CompletedTask; }

    private sealed class CoreStatusServer : IDisposable
    {
        private readonly TcpListener listener = new(IPAddress.Loopback, 0);
        private readonly Task task;
        private readonly CancellationTokenSource cancellation = new();
        private readonly byte[] status;
        private int stops;
        internal string Endpoint { get; }
        internal int Stops => stops;
        internal CoreStatusServer(string root, CoreLaunchIdentity launch)
        {
            listener.Start(); Endpoint = "http://127.0.0.1:" + ((IPEndPoint)listener.LocalEndpoint).Port;
            status = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { status = "running", component = "hosty-core", dataRoot = root,
                listenUrl = Endpoint, corePort = ((IPEndPoint)listener.LocalEndpoint).Port, warnings = Array.Empty<string>(),
                launch = new { mode = launch.Mode, projectPath = launch.ProjectPath, generationPath = launch.GenerationPath,
                    processId = launch.ProcessId, startedAt = launch.StartedAt } }));
            task = Task.Run(async () =>
            {
                try
                {
                    while (!cancellation.IsCancellationRequested)
                    {
                        using var client = await listener.AcceptTcpClientAsync(cancellation.Token);
                        await using var stream = client.GetStream();
                        using var reader = new StreamReader(stream, leaveOpen: true);
                        var request = await reader.ReadLineAsync();
                        if (request?.StartsWith("POST ", StringComparison.Ordinal) == true) Interlocked.Increment(ref stops);
                        while (!string.IsNullOrEmpty(await reader.ReadLineAsync())) { }
                        var headers = Encoding.ASCII.GetBytes($"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {status.Length}\r\nConnection: close\r\n\r\n");
                        await stream.WriteAsync(headers); await stream.WriteAsync(status);
                    }
                }
                catch (Exception ex) when (ex is OperationCanceledException or ObjectDisposedException) { }
            });
        }
        public void Dispose() { cancellation.Cancel(); listener.Stop(); task.GetAwaiter().GetResult(); cancellation.Dispose(); }
    }
}
