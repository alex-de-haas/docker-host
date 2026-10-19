using System.Diagnostics;
using System.Text.Json;
using Haas.Hosty.Cli.Commands;
using Haas.Hosty.Cli.Configuration;
using Spectre.Console;

namespace Haas.Hosty.Cli.Tests.Commands;

public sealed class CoreProvenanceTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "hosty-provenance-" + Guid.NewGuid().ToString("N"));

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task PreparedBinaryRetainsForkIdentityAfterCheckoutChanges(bool managed)
    {
        var source = await SourceAsync();
        const string fork = "https://git.example.test/team/core-fork.git";
        if (managed)
        {
            var development = Path.Combine(root, "data", "development");
            var bare = Path.Combine(development, "repositories", "repository.git");
            Directory.CreateDirectory(Path.GetDirectoryName(bare)!);
            await Run("git", root, "clone", "--bare", source, bare);
            // Core's bare stores have no origin, and the registered record carries the repository identity.
            await Run("git", bare, "remote", "remove", "origin");
            var id = new string('a', 64);
            source = Path.Combine(development, "trees", id);
            await Run("git", bare, "worktree", "add", "-b", "task", source, "main");
            Directory.CreateDirectory(Path.Combine(development, "workspaces"));
            await File.WriteAllTextAsync(Path.Combine(development, "workspaces", id + ".json"),
                JsonSerializer.Serialize(new { path = source, repository = fork }));
        }
        else await Run("git", source, "remote", "add", "origin", fork);
        var project = Path.Combine(source, "Core.csproj");
        Assert.Equal(fork, await CoreBuildRepository.ReadAsync(project));
        var commit = (await Run("git", source, "rev-parse", "HEAD")).Trim();
        using var output = new StringWriter();
        var console = AnsiConsole.Create(new AnsiConsoleSettings { Ansi = AnsiSupport.No, Out = new AnsiConsoleOutput(output) });
        var build = new CoreBuildService(new CommandContext(console, HostyEnvironment.Current(Path.Combine(root, "data"))));
        var target = await build.PrepareAsync(project);
        var before = await Run(target.FileName, source);
        Assert.Contains(fork, before);
        Assert.Contains(commit, before);
        Assert.Contains("False", before);
        Assert.Contains("Core.csproj", before);
        await File.AppendAllTextAsync(Path.Combine(source, "Program.cs"), "\n// a later live edit\n");
        Assert.Equal(before, await Run(target.FileName, source));
        Assert.Contains("later live edit", await File.ReadAllTextAsync(Path.Combine(source, "Program.cs")));
        var rebuilt = await build.PrepareAsync(project);
        Assert.Contains("True", await Run(rebuilt.FileName, source));
        Assert.Equal(before, await Run(target.FileName, source));
    }

    [Theory]
    [InlineData("https://secret:credential@git.example.test/team/repo")]
    [InlineData("https://git.example.test/team/repo?token=credential")]
    public async Task SecretBearingOriginRemainsUnknown(string remote)
    {
        var source = await SourceAsync();
        await Run("git", source, "remote", "add", "origin", remote);
        Assert.Null(await CoreBuildRepository.ReadAsync(Path.Combine(source, "Core.csproj")));
        var output = await Run("dotnet", source, "build", "Core.csproj", "--nologo");
        Assert.DoesNotContain("credential", output);
        var assembly = await File.ReadAllTextAsync(Directory.GetFiles(Path.Combine(source, "obj"), "Core.AssemblyInfo.cs", SearchOption.AllDirectories).Single());
        Assert.DoesNotContain("credential", assembly);
        Assert.Contains("Hosty.Repository\", \"\"", assembly);
    }

    private async Task<string> SourceAsync()
    {
        var source = Path.Combine(root, "source");
        Directory.CreateDirectory(Path.Combine(source, "scripts"));
        var repository = new DirectoryInfo(AppContext.BaseDirectory);
        while (repository is not null && !File.Exists(Path.Combine(repository.FullName, "Directory.Build.targets"))) repository = repository.Parent;
        Assert.NotNull(repository);
        File.Copy(Path.Combine(repository.FullName, "Directory.Build.targets"), Path.Combine(source, "Directory.Build.targets"));
        File.Copy(Path.Combine(repository.FullName, "scripts", "HostyBuildIdentity.cs"), Path.Combine(source, "scripts", "HostyBuildIdentity.cs"));
        File.Copy(Path.Combine(repository.FullName, "shared", "CoreBuildProvenance.cs"), Path.Combine(source, "CoreBuildProvenance.cs"));
        await File.WriteAllTextAsync(Path.Combine(source, "Core.csproj"), """
            <Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework>
            <OutputType>Exe</OutputType><AssemblyName>hosty-core</AssemblyName><ImplicitUsings>enable</ImplicitUsings>
            <Nullable>enable</Nullable></PropertyGroup><ItemGroup><Compile Remove="scripts/**" /></ItemGroup></Project>
            """);
        await File.WriteAllTextAsync(Path.Combine(source, "Program.cs"),
            "System.Console.WriteLine(Haas.Hosty.Launch.CoreBuildProvenance.Current);");
        await File.WriteAllTextAsync(Path.Combine(source, ".gitignore"), "/bin/\n/obj/\n");
        await Run("git", source, "init", "-b", "main");
        await Run("git", source, "add", ".");
        await Run("git", source, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "fixture");
        return source;
    }

    private static async Task<string> Run(string file, string directory, params string[] args)
    {
        var start = new ProcessStartInfo(file) { WorkingDirectory = directory, UseShellExecute = false,
            RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var arg in args) start.ArgumentList.Add(arg);
        using var process = Process.Start(start)!;
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        var text = await output + await error;
        Assert.True(process.ExitCode == 0, text);
        return text;
    }

    public void Dispose()
    {
        if (!Directory.Exists(root)) return;
        foreach (var file in Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories)) File.SetAttributes(file, FileAttributes.Normal);
        Directory.Delete(root, true);
    }
}
