using System.Diagnostics;
using Haas.Hosty.Launch;

namespace Haas.Hosty.Core;

// Owns service pipes and the Windows job independently of Core. Core may exit and reconnect by
// verified PID; the runner keeps draining logs and owns the descendant boundary until explicit stop.
internal static class LocalCommandRunner
{
    public const string Verb = "__local-command-runner";

    private static readonly object preparationLock = new();
    private static readonly Dictionary<string, (string? Executable, string Generation)> prepared = new();

    internal static (string? Executable, string Generation) Prepare(string root, string? executable)
    {
        var generation = Environment.GetEnvironmentVariable("HOSTY_CORE_GENERATION");
        if (!string.IsNullOrEmpty(generation) && executable is not null) return (executable, generation);
        // Installed Core can be replaced while these runners live. Copy its output closure once
        // per Core process, including managed dependencies for dotnet-hosted development launches.
        lock (preparationLock)
        {
            var key = root + "|" + executable;
            if (prepared.TryGetValue(key, out var previous)) return previous;
            generation = Path.Combine(root, "core", "builds", Guid.NewGuid().ToString("N"));
            var output = Path.Combine(generation, "runner");
            Directory.CreateDirectory(output);
            if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(generation, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            var source = executable is null ? AppContext.BaseDirectory : Path.GetDirectoryName(executable)!;
            void Copy(string from, string to)
            {
                Directory.CreateDirectory(to);
                foreach (var file in Directory.EnumerateFiles(from))
                {
                    if (new FileInfo(file).LinkTarget is not null) throw new IOException("Runner output contains a symbolic link.");
                    File.Copy(file, Path.Combine(to, Path.GetFileName(file)));
                }
                foreach (var directory in Directory.EnumerateDirectories(from))
                {
                    if (new DirectoryInfo(directory).LinkTarget is not null) throw new IOException("Runner output contains a symbolic link.");
                    Copy(directory, Path.Combine(to, Path.GetFileName(directory)));
                }
            }
            Copy(source, output);
            CoreBuildRetention.Mark(generation, "runner", null);
            var result = (executable is null ? null : Path.Combine(output, Path.GetFileName(executable)), generation);
            prepared[key] = result;
            return result;
        }
    }

    public static async Task<int> RunAsync(string[] args)
    {
        if (args.Length != 3) return 127;
        var logPath = args[1];
        var command = args[2];
        WindowsProcessControl.WindowsKillOnCloseJob? job = null;
        try
        {
            if (OperatingSystem.IsWindows())
            {
                WindowsProcessControl.MakeStandardHandlesNonInheritable();
                job = WindowsProcessControl.CreateKillOnCloseJob();
                WindowsProcessControl.AssignCurrentProcessToJob(job.Name);
            }
            else UnixProcessControl.SetSid();
            using var log = new LocalCommandLogWriter(new RotatingLogWriter(logPath));
            var start = new ProcessStartInfo(OperatingSystem.IsWindows() ? "cmd.exe" : "/bin/sh")
            {
                UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true,
                RedirectStandardInput = true,
            };
            start.ArgumentList.Add(OperatingSystem.IsWindows() ? "/c" : "-c");
            start.ArgumentList.Add(command);
            using var child = Process.Start(start) ?? throw new IOException("Could not start local service.");
            child.StandardInput.Close();
            async Task PumpAsync(StreamReader reader)
            {
                while (await reader.ReadLineAsync() is { } line) log.TryWriteLine(line);
            }
            var output = Task.WhenAll(PumpAsync(child.StandardOutput), PumpAsync(child.StandardError));
            await child.WaitForExitAsync();
            await Task.WhenAny(output, Task.Delay(TimeSpan.FromSeconds(2)));
            log.TryWriteLine($"[hosty] command exited with code {child.ExitCode}");
            return child.ExitCode;
        }
        finally { job?.Dispose(); }
    }

    public static ProcessStartInfo CreateStartInfo(string? shimPath, string command, string workingDirectory, string logPath, string? generation = null)
    {
        var start = new ProcessStartInfo(shimPath ?? "dotnet")
        {
            WorkingDirectory = workingDirectory, UseShellExecute = false,
            RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true,
            CreateNoWindow = true,
        };
        if (shimPath is null) start.ArgumentList.Add(Path.Combine(generation is null ? AppContext.BaseDirectory : Path.Combine(generation, "runner"), "hosty-core.dll"));
        start.ArgumentList.Add(Verb);
        start.ArgumentList.Add(logPath);
        start.ArgumentList.Add(command);
        return start;
    }
}

// Rotation belongs to the surviving runner too. A reader temporarily locking a file on Windows
// delays rotation until the next write; it must never kill an otherwise healthy application.
internal sealed class RotatingLogWriter(string path) : TextWriter
{
    private StreamWriter writer = Open(path);
    public override System.Text.Encoding Encoding => System.Text.Encoding.UTF8;
    private static StreamWriter Open(string path) => new(SecureFileSystem.CreatePrivateFile(path, FileMode.Append,
        FileShare.ReadWrite | FileShare.Delete, FileOptions.None)) { AutoFlush = true };
    public override void WriteLine(string? value)
    {
        if (writer.BaseStream.Length >= 10 * 1024 * 1024)
        {
            writer.Dispose();
            try
            {
                if (File.Exists(path + ".1")) File.Move(path + ".1", path + ".2", true);
                File.Move(path, path + ".1", true);
            }
            catch (IOException) { }
            finally { writer = Open(path); }
        }
        writer.WriteLine(value);
    }
    protected override void Dispose(bool disposing) { if (disposing) writer.Dispose(); base.Dispose(disposing); }
}
