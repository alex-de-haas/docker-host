namespace Haas.DockerHost.Cli.Commands;

using Haas.DockerHost.Cli.Configuration;
using Spectre.Console;

internal sealed class UninstallCommand(CommandContext context)
{
    public async Task<int> ExecuteAsync(string[] args)
    {
        if (args.Length > 0)
        {
            throw new CommandUsageException("uninstall does not accept arguments.", "Usage: hosty uninstall");
        }

        await TryStopCoreAsync();

        var fileCleanup = HostUninstallFileCleanup.Delete(context.Environment, context.Environment.RootDirectory);
        foreach (var path in fileCleanup.DeletedPaths)
        {
            context.Console.MarkupLine($"Removed [grey]{Markup.Escape(path)}[/]");
        }

        foreach (var path in fileCleanup.SkippedPaths)
        {
            context.Console.MarkupLine($"[yellow]Skipped[/] [grey]{Markup.Escape(path)}[/]");
        }

        context.Console.MarkupLine("[green]Hosty local state has been uninstalled.[/]");
        context.Console.MarkupLine($"CLI directory preserved: [grey]{Markup.Escape(context.Environment.BinDirectory)}[/]");
        context.Console.MarkupLine("Run [grey]hosty install[/] to recreate local Hosty directories.");
        return 0;
    }

    private async Task TryStopCoreAsync()
    {
        using var core = await CoreControlClient.TryCreateAsync(context);
        if (core is null)
        {
            return;
        }

        try
        {
            await core.PostAsync<object>("core/stop");
            context.Console.MarkupLine("[grey]Hosty Core stop requested.[/]");
            await Task.Delay(750);
        }
        catch (Exception ex) when (ex is CoreControlException or HttpRequestException or IOException or TaskCanceledException)
        {
            context.Console.MarkupLine($"[yellow]Could not stop Hosty Core before uninstall:[/] {Markup.Escape(ex.Message)}");
        }
    }
}

internal sealed record HostUninstallFileCleanupResult(
    IReadOnlyList<string> DeletedPaths,
    IReadOnlyList<string> SkippedPaths);

internal static class HostUninstallFileCleanup
{
    public static HostUninstallFileCleanupResult Delete(DockerHostEnvironment environment, string dataRoot)
    {
        var deletedPaths = new List<string>();
        var skippedPaths = new List<string>();
        var rootDirectory = Path.GetFullPath(environment.RootDirectory);
        var binDirectory = Path.GetFullPath(environment.BinDirectory);
        var dataRootDirectory = Path.GetFullPath(dataRoot);

        try
        {
            if (IsSamePath(dataRootDirectory, rootDirectory))
            {
                DeleteDirectoryContentsExcept(rootDirectory, binDirectory, deletedPaths);
            }
            else
            {
                DeletePath(environment.ConfigDirectory, deletedPaths);
                DeleteDataRoot(environment, dataRootDirectory, deletedPaths, skippedPaths);
            }

            Directory.CreateDirectory(rootDirectory);
            Directory.CreateDirectory(binDirectory);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw new ConfigurationException($"Unable to remove Docker Host files: {ex.Message}");
        }

        return new HostUninstallFileCleanupResult(deletedPaths, skippedPaths);
    }

    private static void DeleteDataRoot(
        DockerHostEnvironment environment,
        string dataRoot,
        ICollection<string> deletedPaths,
        ICollection<string> skippedPaths)
    {
        if (IsSamePath(dataRoot, environment.BinDirectory) || IsChildPath(dataRoot, environment.BinDirectory))
        {
            skippedPaths.Add(dataRoot);
            return;
        }

        if (IsSamePath(dataRoot, environment.RootDirectory) || IsChildPath(dataRoot, environment.RootDirectory))
        {
            DeletePath(dataRoot, deletedPaths);
            return;
        }

        DeletePath(Path.Combine(dataRoot, "apps.json"), deletedPaths);
        DeletePath(Path.Combine(dataRoot, "apps"), deletedPaths);
        DeletePath(Path.Combine(dataRoot, "backups"), deletedPaths);
        DeletePath(Path.Combine(dataRoot, "sources"), deletedPaths);
        DeletePath(Path.Combine(dataRoot, "core"), deletedPaths);
    }

    private static void DeleteDirectoryContentsExcept(string directory, string preservedDirectory, ICollection<string> deletedPaths)
    {
        if (!Directory.Exists(directory))
        {
            return;
        }

        foreach (var entry in Directory.EnumerateFileSystemEntries(directory))
        {
            if (IsSamePath(entry, preservedDirectory))
            {
                continue;
            }

            DeletePath(entry, deletedPaths);
        }
    }

    private static void DeletePath(string path, ICollection<string> deletedPaths)
    {
        if (File.Exists(path))
        {
            File.Delete(path);
            deletedPaths.Add(Path.GetFullPath(path));
            return;
        }

        if (Directory.Exists(path))
        {
            Directory.Delete(path, recursive: true);
            deletedPaths.Add(Path.GetFullPath(path));
        }
    }

    private static bool IsSamePath(string left, string right)
        => string.Equals(NormalizePath(left), NormalizePath(right), PathComparison);

    private static bool IsChildPath(string path, string parent)
    {
        var normalizedPath = NormalizePath(path);
        var normalizedParent = NormalizePath(parent);
        return normalizedPath.StartsWith($"{normalizedParent}{Path.DirectorySeparatorChar}", PathComparison);
    }

    private static string NormalizePath(string path)
        => Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);

    private static StringComparison PathComparison
        => OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
}
