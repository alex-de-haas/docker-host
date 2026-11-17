using System.Diagnostics;
using System.Xml.Linq;

namespace Haas.Hosty.Cli.Tests;

public sealed class WindowsDetachedLaunchTests
{
    [WindowsDetachedFact]
    public async Task DetachedHelper_ClosesLauncherCaptureWhileChildRemainsAlive()
    {
        var root = Directory.CreateTempSubdirectory("hosty detached capture ").FullName;
        var identityPath = Path.Combine(root, "child.identity");
        var stopPath = Path.Combine(root, "child.stop");
        var logPath = Path.Combine(root, "child.log");
        Process? launcher = null;
        Process? child = null;
        StreamReader? stdout = null;
        StreamReader? stderr = null;
        Task<string>? output = null;
        Task<string>? error = null;
        try
        {
            var executable = await BuildProbeAsync(root);
            launcher = Process.Start(new ProcessStartInfo(executable)
            {
                ArgumentList = { "launch", root },
                UseShellExecute = false,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            })!;
            launcher.StandardInput.Close();
            stdout = launcher.StandardOutput;
            stderr = launcher.StandardError;
            output = stdout.ReadToEndAsync();
            error = stderr.ReadToEndAsync();

            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            while (!File.Exists(identityPath))
            {
                await Task.Delay(20, deadline.Token);
            }
            child = OpenOwnedChild(identityPath);
            Assert.NotNull(child);
            await launcher.WaitForExitAsync(deadline.Token);
            Assert.Equal(0, launcher.ExitCode);
            Assert.False(child.HasExited);

            // A long-lived cmd wrapper must not retain the launcher's redirected handles.
            // On .NET 11, clearing their inherit flags alone no longer prevents this leak.
            await Task.WhenAll(output, error).WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Contains("launcher-completed", await output);
            Assert.Contains("launcher-error", await error);
            Assert.False(child.HasExited);
            await using var logStream = new FileStream(logPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var logReader = new StreamReader(logStream);
            var log = await logReader.ReadToEndAsync();
            Assert.Contains("child-standard-output", log);
            Assert.Contains("child-standard-error", log);
        }
        finally
        {
            // The child is self-bounded as a final guard. Prefer its explicit stop marker,
            // then terminate only the identity recorded by this fixture if it cannot stop.
            await File.WriteAllTextAsync(stopPath, "stop");
            if (launcher is not null && !launcher.HasExited)
            {
                launcher.Kill(entireProcessTree: true);
                await launcher.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
            }
            child ??= OpenOwnedChild(identityPath);
            if (child is not null)
            {
                try { await child.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5)); }
                catch (TimeoutException)
                {
                    child.Kill(entireProcessTree: true);
                    await child.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
                }
                Assert.True(child.HasExited);
                child.Dispose();
            }
            if (output is not null && error is not null)
                await Task.WhenAll(output, error).WaitAsync(TimeSpan.FromSeconds(10));
            stdout?.Dispose();
            stderr?.Dispose();
            launcher?.Dispose();
            // cmd can release the redirection handle just after its child has exited.
            var cleanup = Stopwatch.StartNew();
            while (true)
            {
                try { Directory.Delete(root, recursive: true); break; }
                catch (IOException) when (cleanup.Elapsed < TimeSpan.FromSeconds(5)) { await Task.Delay(20); }
            }
        }
    }

    private static Process? OpenOwnedChild(string identityPath)
    {
        if (!File.Exists(identityPath)) return null;
        var fields = File.ReadAllText(identityPath).Split('|');
        try
        {
            var process = Process.GetProcessById(int.Parse(fields[0], System.Globalization.CultureInfo.InvariantCulture));
            if (process.StartTime.ToUniversalTime().Ticks == long.Parse(fields[1], System.Globalization.CultureInfo.InvariantCulture)) return process;
            process.Dispose();
            throw new InvalidOperationException("The detached test child's process identity changed.");
        }
        catch (ArgumentException) { return null; } // The owned child already exited.
    }

    private static async Task<string> BuildProbeAsync(string root)
    {
        var repository = new DirectoryInfo(AppContext.BaseDirectory);
        while (repository is not null && !File.Exists(Path.Combine(repository.FullName, "shared", "DetachedCliProcess.cs"))) repository = repository.Parent;
        Assert.NotNull(repository);
        var project = Path.Combine(root, "DetachedProbe.csproj");
        var output = Path.Combine(root, "output");
        new XDocument(new XElement("Project", new XAttribute("Sdk", "Microsoft.NET.Sdk"),
            new XElement("PropertyGroup", new XElement("TargetFramework", "net11.0"), new XElement("OutputType", "Exe"),
                new XElement("ImplicitUsings", "enable"), new XElement("Nullable", "enable")),
            new XElement("ItemGroup",
                new XElement("Compile", new XAttribute("Include", Path.Combine(repository.FullName, "shared", "DetachedCliProcess.cs"))),
                new XElement("Compile", new XAttribute("Include", Path.Combine(repository.FullName, "apps", "cli", "src", "Haas.Hosty.Cli", "WindowsProcessControl.cs"))))))
            .Save(project);
        await File.WriteAllTextAsync(Path.Combine(root, "Program.cs"), """
            using System.Diagnostics;
            using Haas.Hosty.Cli;
            using Haas.Hosty.Launch;
            if (!OperatingSystem.IsWindows()) return 2;
            var root = args[1];
            if (args[0] == "child")
            {
                Console.WriteLine("child-standard-output");
                Console.Error.WriteLine("child-standard-error");
                await Console.Out.FlushAsync();
                await Console.Error.FlushAsync();
                using var current = Process.GetCurrentProcess();
                var identity = current.Id.ToString(System.Globalization.CultureInfo.InvariantCulture) + "|" +
                    current.StartTime.ToUniversalTime().Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture);
                await File.WriteAllTextAsync(Path.Combine(root, "child.identity.tmp"), identity);
                File.Move(Path.Combine(root, "child.identity.tmp"), Path.Combine(root, "child.identity"));
                var elapsed = Stopwatch.StartNew();
                while (!File.Exists(Path.Combine(root, "child.stop")) && elapsed.Elapsed < TimeSpan.FromSeconds(30)) await Task.Delay(20);
                return 0;
            }
            WindowsProcessControl.MakeStandardHandlesNonInheritable();
            DetachedCliProcess.SpawnDetached(Environment.ProcessPath!, ["child", root], root, "helper.log", Path.Combine(root, "child.log"));
            Console.WriteLine("launcher-completed");
            Console.Error.WriteLine("launcher-error");
            return 0;
            """);
        var start = new ProcessStartInfo("dotnet")
        {
            UseShellExecute = false, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
        };
        foreach (var argument in new[] { "build", project, "--output", output, "--nologo", "--disable-build-servers" }) start.ArgumentList.Add(argument);
        using var build = Process.Start(start)!;
        build.StandardInput.Close();
        using var stdout = build.StandardOutput;
        using var stderr = build.StandardError;
        var text = stdout.ReadToEndAsync();
        var errors = stderr.ReadToEndAsync();
        try
        {
            await build.WaitForExitAsync().WaitAsync(TimeSpan.FromMinutes(1));
            await Task.WhenAll(text, errors).WaitAsync(TimeSpan.FromSeconds(10));
            Assert.True(build.ExitCode == 0, await text + await errors);
        }
        finally
        {
            if (!build.HasExited)
            {
                build.Kill(entireProcessTree: true);
                await build.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
            }
        }
        return Path.Combine(output, "DetachedProbe.exe");
    }

    private sealed class WindowsDetachedFactAttribute : FactAttribute
    {
        public WindowsDetachedFactAttribute()
        {
            if (!OperatingSystem.IsWindows()) Skip = "Requires Windows process handle inheritance.";
        }
    }
}
