namespace Haas.DockerHost.Cli.Commands;

using Haas.DockerHost.Cli.Configuration;
using Haas.DockerHost.Cli.Docker;
using Spectre.Console;

internal sealed class UninstallCommand(CommandContext context)
{
    public async Task<int> ExecuteAsync(string[] args)
    {
        if (args.Length > 0)
        {
            throw new CommandUsageException("uninstall does not accept arguments.", "Usage: docker-host uninstall");
        }

        var settings = context.SettingsStore.Load();
        var dataRoot = settings.ResolveHostDataRoot(context.Environment);
        var moduleLoadResult = ModuleCleanupRecord.LoadFromDataRoot(dataRoot);

        if (moduleLoadResult.Error is not null)
        {
            context.Console.MarkupLine($"[yellow]Could not read installed module registry:[/] {Markup.Escape(moduleLoadResult.Error)}");
            context.Console.MarkupLine("[yellow]Module containers may need manual cleanup after uninstall.[/]");
        }

        using var docker = context.DockerFactory.Create(settings.HostDockerEndpoint);
        await CommandStatus.RunAsync(
            context,
            "Checking Docker Engine...",
            async () => await docker.EnsureLinuxEngineAsync());

        foreach (var module in moduleLoadResult.Modules)
        {
            foreach (var container in module.Containers)
            {
                await TryRemoveModuleContainerAsync(docker, container.ContainerName);
            }
        }

        await CommandStatus.RunAsync(
            context,
            $"Removing Host container [grey]{Markup.Escape(settings.HostContainerName)}[/]...",
            async () => await docker.RemoveContainerAsync(settings.HostContainerName));

        foreach (var image in EnumerateImages(settings, moduleLoadResult.Modules))
        {
            await TryRemoveImageAsync(docker, image);
        }

        await TryRemoveNetworkAsync(docker, settings.HostModuleNetwork);

        var fileCleanup = HostUninstallFileCleanup.Delete(context.Environment, dataRoot);
        foreach (var path in fileCleanup.DeletedPaths)
        {
            context.Console.MarkupLine($"Removed [grey]{Markup.Escape(path)}[/]");
        }

        foreach (var path in fileCleanup.SkippedPaths)
        {
            context.Console.MarkupLine($"[yellow]Skipped[/] [grey]{Markup.Escape(path)}[/]");
        }

        context.Console.MarkupLine("[green]Docker Host has been uninstalled.[/]");
        context.Console.MarkupLine($"CLI directory preserved: [grey]{Markup.Escape(context.Environment.BinDirectory)}[/]");
        context.Console.MarkupLine("Run [grey]docker-host install[/] to recreate launch configuration and Host directories.");
        return 0;
    }

    private async Task TryRemoveNetworkAsync(DockerEngineClient docker, string networkName)
    {
        try
        {
            await CommandStatus.RunAsync(
                context,
                $"Removing module network [grey]{Markup.Escape(networkName)}[/]...",
                async () => await docker.RemoveNetworkAsync(networkName));
        }
        catch (DockerEngineException ex)
        {
            context.Console.MarkupLine($"[yellow]Could not remove Docker network {Markup.Escape(networkName)}:[/] {Markup.Escape(ex.Message)}");
            if (!string.IsNullOrWhiteSpace(ex.DockerMessage))
            {
                context.Console.MarkupLine($"[grey]Docker message:[/] {Markup.Escape(ex.DockerMessage)}");
            }
        }
    }

    private async Task TryRemoveModuleContainerAsync(DockerEngineClient docker, string containerName)
    {
        try
        {
            await CommandStatus.RunAsync(
                context,
                $"Removing module container [grey]{Markup.Escape(containerName)}[/]...",
                async () => await docker.RemoveContainerAsync(containerName));
        }
        catch (DockerEngineException ex)
        {
            context.Console.MarkupLine($"[yellow]Could not remove module container {Markup.Escape(containerName)}:[/] {Markup.Escape(ex.Message)}");
            if (!string.IsNullOrWhiteSpace(ex.DockerMessage))
            {
                context.Console.MarkupLine($"[grey]Docker message:[/] {Markup.Escape(ex.DockerMessage)}");
            }
        }
    }

    private async Task TryRemoveImageAsync(DockerEngineClient docker, string image)
    {
        try
        {
            await CommandStatus.RunAsync(
                context,
                $"Removing Docker image [grey]{Markup.Escape(image)}[/]...",
                async () => await docker.RemoveImageAsync(image));
        }
        catch (DockerEngineException ex)
        {
            context.Console.MarkupLine($"[yellow]Could not remove Docker image {Markup.Escape(image)}:[/] {Markup.Escape(ex.Message)}");
            if (!string.IsNullOrWhiteSpace(ex.DockerMessage))
            {
                context.Console.MarkupLine($"[grey]Docker message:[/] {Markup.Escape(ex.DockerMessage)}");
            }
        }
    }

    private static IEnumerable<string> EnumerateImages(LaunchSettings settings, IEnumerable<ModuleCleanupRecord> modules)
    {
        var images = new SortedSet<string>(StringComparer.Ordinal);

        if (!string.IsNullOrWhiteSpace(settings.HostImage))
        {
            images.Add(settings.HostImage);
        }

        foreach (var module in modules)
        {
            foreach (var image in module.ImageReferences)
            {
                images.Add(image);
            }
        }

        return images;
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
                DeletePath(environment.ModulesDirectory, deletedPaths);
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

        DeletePath(Path.Combine(dataRoot, "modules.json"), deletedPaths);
        DeletePath(Path.Combine(dataRoot, "modules"), deletedPaths);
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
