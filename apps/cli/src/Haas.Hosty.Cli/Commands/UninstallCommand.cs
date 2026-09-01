namespace Haas.Hosty.Cli.Commands;

using Haas.Hosty.Cli.Configuration;
using Spectre.Console;

internal sealed class UninstallCommand(CommandContext context)
{
    private const string Usage = "Usage: hosty uninstall --yes [--delete-data]";

    public async Task<int> ExecuteAsync(string[] args)
    {
        var options = ParseOptions(args);

        await TryStopCoreAsync();

        // The CLI's resolved root IS the data root now (--data-root / HOSTY_DATA_ROOT / default) —
        // launch.env, the only thing that used to remember a different one, is retired. An operator
        // uninstalling an external root selects it the same way every other command addresses it.
        var dataRoot = context.Environment.RootDirectory;

        var fileCleanup = HostUninstallFileCleanup.Delete(context.Environment, dataRoot, options.DeleteData);
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
        if (!options.DeleteData)
        {
            context.Console.MarkupLine($"App data preserved: [grey]{Markup.Escape(dataRoot)}[/]");
            context.Console.MarkupLine("Rerun with [grey]hosty uninstall --yes --delete-data[/] to also delete app data, backups, and sources.");
        }

        context.Console.MarkupLine("Run [grey]hosty install[/] to recreate local Hosty directories.");
        return 0;
    }

    private static UninstallOptions ParseOptions(string[] args)
    {
        var confirmed = false;
        var deleteData = false;
        foreach (var arg in args)
        {
            switch (arg)
            {
                case "--yes":
                    confirmed = true;
                    break;
                case "--delete-data":
                    deleteData = true;
                    break;
                default:
                    throw new CommandUsageException($"Unknown uninstall argument '{arg}'.", Usage);
            }
        }

        if (!confirmed)
        {
            throw new CommandUsageException(
                "hosty uninstall permanently removes Hosty local state and requires --yes to confirm. Add --delete-data to also delete app data, backups, and sources.",
                Usage);
        }

        return new UninstallOptions(deleteData);
    }

    private async Task TryStopCoreAsync()
    {
        using var core = await CoreControlClient.TryCreateAsync(context);
        if (core is null)
        {
            return;
        }

        var processId = core.CoreProcessId;
        try
        {
            await core.PostAsync("core/stop");
            context.Console.MarkupLine("[grey]Hosty Core stop requested.[/]");

            // Wait for the process to actually exit before deleting files a dying Core may still hold or
            // recreate (on Windows a locked exe throws mid-deletion). /core/stop only signals shutdown; the
            // 15s Core shutdown budget can outlast a fixed short delay. Fall back to a short delay when the
            // discovery file records no PID (older Core).
            if (processId is int pid && pid > 0)
            {
                if (!await ProcessLiveness.WaitForExitAsync(pid, TimeSpan.FromSeconds(20)))
                {
                    context.Error.MarkupLine("[yellow]Hosty Core did not exit within 20s; some files may be locked or recreated during uninstall.[/]");
                }
            }
            else
            {
                await Task.Delay(750);
            }
        }
        catch (Exception ex) when (ex is CoreControlException or HttpRequestException or IOException or TaskCanceledException)
        {
            context.Console.MarkupLine($"[yellow]Could not stop Hosty Core before uninstall:[/] {Markup.Escape(ex.Message)}");
        }
    }

    private sealed record UninstallOptions(bool DeleteData);
}

internal sealed record HostUninstallFileCleanupResult(
    IReadOnlyList<string> DeletedPaths,
    IReadOnlyList<string> SkippedPaths);

internal static class HostUninstallFileCleanup
{
    public static HostUninstallFileCleanupResult Delete(HostyEnvironment environment, string dataRoot, bool deleteData)
    {
        var deletedPaths = new List<string>();
        var skippedPaths = new List<string>();
        var rootDirectory = Path.GetFullPath(environment.RootDirectory);
        var binDirectory = Path.GetFullPath(environment.BinDirectory);
        var dataRootDirectory = Path.GetFullPath(dataRoot);

        try
        {
            // The launch config (launch.env / auth.json) is install state and is always removed.
            DeletePath(environment.ConfigDirectory, deletedPaths);

            if (deleteData)
            {
                if (IsSamePath(dataRootDirectory, rootDirectory))
                {
                    DeleteDirectoryContentsExcept(rootDirectory, binDirectory, deletedPaths);
                }
                else
                {
                    DeleteDataRoot(environment, dataRootDirectory, deletedPaths, skippedPaths);
                }
            }
            else
            {
                // Keep user data (apps.json, apps/, backups/, sources/); remove only Core runtime state.
                DeleteCoreRuntimeState(environment, dataRootDirectory, deletedPaths, skippedPaths);
            }

            Directory.CreateDirectory(rootDirectory);
            Directory.CreateDirectory(binDirectory);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw new ConfigurationException($"Unable to remove Hosty files: {ex.Message}");
        }

        return new HostUninstallFileCleanupResult(deletedPaths, skippedPaths);
    }

    private static void DeleteCoreRuntimeState(
        HostyEnvironment environment,
        string dataRoot,
        ICollection<string> deletedPaths,
        ICollection<string> skippedPaths)
    {
        if (IsSamePath(dataRoot, environment.BinDirectory) || IsChildPath(dataRoot, environment.BinDirectory))
        {
            skippedPaths.Add(dataRoot);
            return;
        }

        DeletePath(Path.Combine(dataRoot, "core"), deletedPaths);
    }

    private static void DeleteDataRoot(
        HostyEnvironment environment,
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
