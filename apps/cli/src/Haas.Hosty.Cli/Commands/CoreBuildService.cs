using System.Diagnostics;
using System.Collections.Concurrent;
using Haas.Hosty.Launch;
using Spectre.Console;

namespace Haas.Hosty.Cli.Commands;

// Build into a private generation before touching the running Core. The apphost and all managed
// dependencies stay together; launching this apphost also preserves Core's local-command shim.
internal sealed class CoreBuildService(CommandContext context)
{
    internal async Task<CoreCommand.CoreStartTarget> PrepareAsync(string projectPath)
    {
        projectPath = Path.GetFullPath(projectPath);
        if (!File.Exists(projectPath)) throw new IOException($"Core project was not found: {projectPath}");
        var generation = Path.Combine(context.Environment.RootDirectory, "core", "builds", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(generation);
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(generation, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        CoreBuildRetention.Mark(generation, "building", projectPath);
        var logPath = Path.Combine(generation, "build.log");
        var start = new ProcessStartInfo("dotnet")
        {
            WorkingDirectory = Path.GetDirectoryName(projectPath)!,
            UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true,
        };
        foreach (var arg in new[] { "build", projectPath, "--artifacts-path", Path.Combine(generation, "artifacts"),
                     "--configuration", "Debug", "-p:UseAppHost=true", "--nologo" }) start.ArgumentList.Add(arg);
        context.Console.WriteLine($"Building Core: {projectPath}");
        context.Console.WriteLine($"Build log: {logPath}");
        using var process = Process.Start(start) ?? throw new IOException("Unable to start dotnet build.");
        using var log = TextWriter.Synchronized(new StreamWriter(logPath) { AutoFlush = true });
        var diagnostics = new ConcurrentQueue<string>();
        async Task PumpAsync(StreamReader reader, IAnsiConsole console)
        {
            while (await reader.ReadLineAsync() is { } line)
            {
                log.WriteLine(line);
                console.WriteLine(line);
                if (line.Contains(": error", StringComparison.OrdinalIgnoreCase))
                {
                    diagnostics.Enqueue(line.Length > 500 ? line[..500] : line);
                    while (diagnostics.Count > 6) diagnostics.TryDequeue(out _);
                }
            }
        }
        await Task.WhenAll(PumpAsync(process.StandardOutput, context.Console), PumpAsync(process.StandardError, context.Error), process.WaitForExitAsync());
        if (process.ExitCode != 0)
        {
            CoreBuildRetention.Mark(generation, "failed", projectPath);
            throw new IOException($"Core build failed (dotnet exit code {process.ExitCode}). The running Core was not stopped. Log: {logPath}\n{string.Join("\n", diagnostics.Distinct())}");
        }
        var name = OperatingSystem.IsWindows() ? "hosty-core.exe" : "hosty-core";
        var candidates = Directory.GetFiles(Path.Combine(generation, "artifacts", "bin"), name, SearchOption.AllDirectories)
            .Where(path => File.Exists(Path.Combine(Path.GetDirectoryName(path)!, "hosty-core.runtimeconfig.json"))).ToArray();
        if (candidates.Length != 1) throw new IOException($"Expected one runnable Core output, found {candidates.Length}. Log: {logPath}");
        await File.WriteAllTextAsync(Path.Combine(generation, "project.txt"), projectPath);
        CoreBuildRetention.Mark(generation, "prepared", projectPath);
        return new CoreCommand.CoreStartTarget(candidates[0], Path.GetDirectoryName(projectPath)!, [], projectPath, generation);
    }
}
